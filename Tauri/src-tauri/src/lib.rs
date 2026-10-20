//! Chat for the desktop.
//!
//! The UI is the website's own, built from `../web` and bundled into the app:
//! it is served from inside the binary at `tauri://localhost` and opens with
//! no network round trip. It talks to the same API as the website, at
//! chat.belayet.app, across origins — the Worker allows this app's origins,
//! and the session is a bearer token kept in the system's credential store
//! instead of a cookie (`web/lib/api.ts`). Bundling also means the code that
//! holds the vault key is the code in the installed app, not whatever a
//! server sends.
//!
//! What the native side provides:
//!
//! - `window.__CHAT_DESKTOP__` before any page script runs — the API's origin
//!   and the platform. It is what switches the UI into desktop mode.
//! - The session token's home: commands over the system's credential store —
//!   the Keychain on macOS, Credential Manager on Windows, the Secret Service
//!   (GNOME Keyring, KWallet) on Linux — plus the OpenRouter code that comes
//!   back through the `belayet-chat://` deep link after the user approves in
//!   their browser.
//! - A window without a title bar on macOS: the traffic lights sit in the
//!   page's own top rows, and are put back there whenever macOS moves them
//!   (`LIGHTS`; `web/app/globals.css`, "the desktop app's window").
//! - Links leave: anything that is not the bundled UI opens in the default
//!   browser. Downloads land in Downloads and are revealed.
//! - On macOS closing the window hides it, so a reply keeps streaming; once it
//!   has been closed a while with nothing in flight, the page asks to be let
//!   go and the window is destroyed, giving WebKit's memory back. The Dock
//!   builds a new one (`release_window`, `web/lib/release.ts`).
//!
//! The bundled UI is the only content the window ever shows, and the only
//! content the capabilities (`capabilities/default.json`) reach.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, PoisonError,
    },
};

use tauri::{
    utils::config::BackgroundThrottlingPolicy,
    webview::{Color, DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, Runtime, State, Url, Webview, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

/// The API. A test build can point elsewhere at compile time:
/// `CHAT_API=http://localhost:8787 npm run dev:local`.
const API: &str = match option_env!("CHAT_API") {
    Some(api) => api,
    None => "https://chat.belayet.app",
};

const MAIN_WINDOW: &str = "main";

/// Where the traffic lights sit: the close button's left edge, and the inset
/// tao turns into the title-bar height. Three 14px lights from x 18 with
/// their centre 32px from the top (it comes out at `y - 2`) — the line the
/// page centres its top rows on (`--dial-lights-x` and `--dial-lights-y` in
/// web/app/globals.css). Change them together.
#[cfg(target_os = "macos")]
const LIGHTS: (f64, f64) = (18.0, 34.0);

/// The web app's dark `chrome` token, behind the page while it loads.
const CHROME: Color = Color(14, 14, 14, 255);

/// The URL scheme the OpenRouter relay page opens (`web/lib/pkce.ts`).
const DEEP_LINK_SCHEME: &str = "belayet-chat";

/// The credential store item is named by the app's identifier, so a build
/// with another identifier — the local one, `tauri.local.conf.json` — never
/// reads or replaces the installed app's session. One per machine user.
const CREDENTIAL_ACCOUNT: &str = "session";

/// A Better Auth session token is under a hundred characters; anything far
/// longer is not one.
const MAX_TOKEN_CHARS: usize = 4096;
const MAX_CODE_CHARS: usize = 512;

/// What the window remembers between launches. Not `VISIBLE`: on macOS a
/// closed window is only hidden, so quitting from there would save "hidden"
/// and the next launch would open with no window at all. Not `FULLSCREEN`
/// either — entering full screen on a window that is not yet shown is not
/// something to rely on.
const REMEMBERED: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/* ------------------------------ navigation ------------------------------ */

/// The bundled UI: `tauri://localhost` on macOS and Linux,
/// `http://tauri.localhost` on Windows.
fn is_local(url: &Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Whether the window may go to `url`. WebKit asks about subframes as well;
/// the UI has none. Everything that is not the bundled UI belongs in a
/// browser — the website included, and OpenRouter's approval page, which
/// comes back through the deep link.
fn stays(url: &Url) -> bool {
    is_local(url) || url.scheme() == "about"
}

/// Only these go to the default browser or mail client. A link in a model's
/// answer must not be able to launch an arbitrary URL handler on this machine.
fn may_open_outside(url: &Url) -> bool {
    matches!(url.scheme(), "https" | "http" | "mailto")
}

fn open_outside<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if may_open_outside(url) {
        if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("chat: could not open {url}: {error}");
        }
    }
}

/// Saves to the Downloads folder under the page's suggested name, numbered if
/// taken (the location wry chooses), and reveals the file once it is written.
/// macOS reports the destination only when a download starts, so it is kept
/// until the download finishes.
fn download_handler<R: Runtime>(
) -> impl Fn(Webview<R>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    let started: Mutex<HashMap<Url, PathBuf>> = Mutex::new(HashMap::new());
    move |webview, event| {
        match event {
            DownloadEvent::Requested { url, destination } => {
                started
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(url, destination.clone());
            }
            DownloadEvent::Finished { url, path, success } => {
                let destination = started
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&url);
                if let (true, Some(path)) = (success, path.or(destination)) {
                    if let Err(error) = webview.opener().reveal_item_in_dir(&path) {
                        eprintln!("chat: could not reveal {}: {error}", path.display());
                    }
                }
            }
            _ => {}
        }
        true
    }
}

/* ------------------------------- session -------------------------------- */

/// The session's item in the system's credential store. Where there is no
/// store to reach — a Linux desktop without a Secret Service running — every
/// command fails, and the UI keeps the token in memory: signed in until the
/// app quits, asked for the password at the next launch.
fn credential<R: Runtime>(app: &AppHandle<R>) -> Result<keyring::Entry, String> {
    keyring::Entry::new(&app.config().identifier, CREDENTIAL_ACCOUNT)
        .map_err(|error| error.to_string())
}

/// The stored session token, if any. Async so a store that prompts — the
/// Keychain asking about an item a differently signed build made — never
/// blocks the main thread. A blank item is a signed-out one
/// (`clear_session_token`).
#[tauri::command]
async fn session_token<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    match credential(&app)?.get_password() {
        Ok(token) if token.is_empty() => Ok(None),
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
async fn set_session_token<R: Runtime>(app: AppHandle<R>, token: String) -> Result<(), String> {
    if token.is_empty() || token.len() > MAX_TOKEN_CHARS {
        return Err("not a session token".into());
    }
    credential(&app)?
        .set_password(&token)
        .map_err(|error| error.to_string())
}

/// Signing out. The Keychain lets only the build that created an item delete
/// it — a later build, signed the same way, may read and overwrite it but not
/// remove it ("Invalid attempt to change the owner of this item", measured)
/// — so where deleting is refused the token is overwritten with nothing,
/// which `session_token` reads as signed out.
#[tauri::command]
async fn clear_session_token<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let entry = credential(&app)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(refused) => entry
            .set_password("")
            .map_err(|error| format!("{refused}; blanking it failed too: {error}")),
    }
}

/* ------------------------------ deep links ------------------------------ */

/// The OpenRouter authorization code a deep link brought, until the UI takes
/// it. Held rather than pushed, so a link that launched the app is not lost
/// before the page is listening.
#[derive(Default)]
struct PendingCode(Mutex<Option<String>>);

/// The code in `belayet-chat://openrouter?code=…`, if that is what this is.
fn openrouter_code(url: &Url) -> Option<String> {
    if url.scheme() != DEEP_LINK_SCHEME || url.host_str() != Some("openrouter") {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, code)| code.into_owned())
        .filter(|code| !code.is_empty() && code.len() <= MAX_CODE_CHARS)
}

fn receive_links<R: Runtime>(app: &AppHandle<R>, urls: &[Url]) {
    for url in urls {
        if let Some(code) = openrouter_code(url) {
            *app.state::<PendingCode>()
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner) = Some(code);
            show_main_window(app);
            if let Err(error) = app.emit_to(MAIN_WINDOW, "openrouter-code", ()) {
                eprintln!("chat: could not announce the OpenRouter code: {error}");
            }
        }
    }
}

#[tauri::command]
fn take_openrouter_code(pending: State<'_, PendingCode>) -> Option<String> {
    pending
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()
}

/* -------------------------------- window -------------------------------- */

/// Whether the window is full screen, as last told to the page.
#[derive(Default)]
struct FullScreen(AtomicBool);

/// Where the main window is in its life. Only macOS leaves `Open`: elsewhere
/// closing the window quits the app.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Open,
    /// Closed by the user: hidden, with the page still running, so a reply
    /// keeps streaming.
    Closed,
    /// Destroyed while closed, at the page's request, to give its memory
    /// back. The app stays in the Dock and builds a new window when asked.
    Released,
    /// Asked for while the release was still taking the old window down:
    /// built as soon as that one is gone.
    Reopening,
}

#[derive(Default)]
struct MainWindow(Mutex<Phase>);

fn phase<R: Runtime>(app: &AppHandle<R>) -> std::sync::MutexGuard<'_, Phase> {
    app.state::<MainWindow>()
        .inner()
        .0
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// The page asks to be let go (`web/lib/release.ts`): the window was closed a
/// while ago and nothing in it is in flight — no reply streaming, no turn
/// unsaved, nothing typed. Honoured only while the window is still closed;
/// decided on the main thread, where the Dock's reopen is handled too, so the
/// two cannot cross.
/// The window's appearance, from the page's theme (`syncWindowTheme` in
/// web/lib/api.ts); no theme follows the system. It is what unfocused lights,
/// context menus and the window behind a resizing page are drawn in. On macOS
/// a new appearance lays the title bar out again, which puts the traffic
/// lights back at macOS's default place, so they are put back in the page's
/// row afterwards.
#[tauri::command]
fn set_window_theme<R: Runtime>(app: AppHandle<R>, theme: Option<String>) -> Result<(), String> {
    let theme = match theme.as_deref() {
        Some("light") => Some(tauri::Theme::Light),
        Some("dark") => Some(tauri::Theme::Dark),
        _ => None,
    };
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.set_theme(theme).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    macos::relight(&app);
    Ok(())
}

#[tauri::command]
fn release_window<R: Runtime>(app: AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let mut phase = phase(&handle);
        if *phase != Phase::Closed || window.is_visible().unwrap_or(true) {
            return;
        }
        *phase = Phase::Released;
        drop(phase);
        #[cfg(debug_assertions)]
        eprintln!("chat: releasing the window");
        if let Err(error) = window.destroy() {
            eprintln!("chat: could not release the window: {error}");
            *self::phase(&handle) = Phase::Closed;
        }
    });
}

/// macOS hides the traffic lights in full screen, so the UI drops the room it
/// keeps for them (`data-fullscreen` on the root element).
fn tell_page_fullscreen<R: Runtime>(app: &AppHandle<R>, fullscreen: bool) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.eval(format!(
            "document.documentElement.toggleAttribute('data-fullscreen', {fullscreen})"
        ));
    }
}

/// Bring the window back: show it, or build it again after a release.
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let window = handle.get_webview_window(MAIN_WINDOW);
        let mut phase = phase(&handle);
        match (*phase, window) {
            // Still on its way out; `on_main_window_destroyed` builds the next.
            (Phase::Released | Phase::Reopening, Some(_)) => *phase = Phase::Reopening,
            (_, Some(window)) => {
                *phase = Phase::Open;
                drop(phase);
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            (_, None) => {
                drop(phase);
                if let Err(error) = open_main_window(&handle) {
                    eprintln!("chat: could not open the window: {error}");
                }
            }
        }
    });
}

/// The old window is gone after a release; if it was asked for meanwhile,
/// build the new one now that the label is free.
fn on_main_window_destroyed<R: Runtime>(app: &AppHandle<R>) {
    let reopen = *phase(app) == Phase::Reopening;
    if reopen {
        if let Err(error) = open_main_window(app) {
            eprintln!("chat: could not open the window: {error}");
        }
    }
}

/// Announced before any page script runs; the boot script and `lib/api.ts`
/// read it.
fn desktop_script() -> String {
    let config = serde_json::json!({ "api": API, "platform": std::env::consts::OS });
    format!(
        "Object.defineProperty(window, '__CHAT_DESKTOP__', {{ value: Object.freeze({config}) }});"
    )
}

fn open_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let name = app.package_info().name.clone();
    let opener = app.clone();

    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title(&name)
        .inner_size(1180.0, 800.0)
        .min_inner_size(420.0, 520.0)
        .center()
        // Shown below, once the window-state plugin has put it back where it was.
        .visible(false)
        .background_color(CHROME)
        // Keep a reply streaming while the window is hidden. WebKit's default
        // suspends a hidden page, and may unload it after a few minutes.
        .background_throttling(BackgroundThrottlingPolicy::Throttle)
        // Files dropped on the window go to the page; the composer takes them.
        .disable_drag_drop_handler()
        .initialization_script(desktop_script())
        .on_navigation({
            let app = app.clone();
            move |url| {
                let keep = stays(url);
                if !keep {
                    open_outside(&app, url);
                }
                keep
            }
        })
        .on_new_window(move |url, _features| {
            open_outside(&opener, &url);
            NewWindowResponse::Deny
        })
        .on_download(download_handler())
        .on_page_load(|window, payload| {
            #[cfg(debug_assertions)]
            eprintln!("chat: {:?} {}", payload.event(), payload.url());

            // A reload while full screen starts the page without the flag.
            if payload.event() == PageLoadEvent::Finished
                && window.state::<FullScreen>().0.load(Ordering::Relaxed)
            {
                tell_page_fullscreen(window.app_handle(), true);
            }
            #[cfg(target_os = "macos")]
            if payload.event() == PageLoadEvent::Finished {
                macos::relight(window.app_handle());
            }
        })
        .on_document_title_changed(move |window, title| {
            #[cfg(debug_assertions)]
            eprintln!("chat: title {title:?}");

            // Hidden on macOS, but it names the window in the Window menu and
            // Mission Control.
            let title = if title.trim().is_empty() {
                name.clone()
            } else {
                title
            };
            let _ = window.set_title(&title);
            // A new title lays the title bar out again (`LIGHTS`).
            #[cfg(target_os = "macos")]
            macos::relight(window.app_handle());
        });

    // The traffic lights sit in the page's top rows (`LIGHTS`). AppKit puts
    // moved buttons back whenever it lays the title bar out — a new title, a
    // theme, focus, a resize — and tao places them only when its view draws,
    // which none of those reliably cause. So after each of them the app asks
    // for that draw (`macos::relight`); without it the lights sat at macOS's
    // default height beside rows built for these, at the first launch and
    // again whenever a conversation's title arrived.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(LIGHTS.0, LIGHTS.1));

    let window = builder.build()?;
    *phase(app) = Phase::Open;
    app.state::<FullScreen>().0.store(false, Ordering::Relaxed);
    window.show()?;
    window.set_focus()?;

    Ok(())
}

/// Every window event the app cares about, on every platform.
fn on_window_event<R: Runtime>(window: &tauri::Window<R>, event: &WindowEvent) {
    if let WindowEvent::Resized(_) = event {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let state = window.state::<FullScreen>();
        if state.0.swap(fullscreen, Ordering::Relaxed) != fullscreen {
            tell_page_fullscreen(window.app_handle(), fullscreen);
        }
    }
    #[cfg(target_os = "macos")]
    {
        // Each of these lays the title bar out again (`LIGHTS`); a theme
        // change here is the system's, under a window following it.
        if let WindowEvent::ThemeChanged(_) | WindowEvent::Focused(_) | WindowEvent::Resized(_) =
            event
        {
            macos::relight(window.app_handle());
        }
        macos::hide_on_close(window, event);
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use tauri::{
        menu::{
            AboutMetadata, Menu, MenuBuilder, MenuEvent, MenuItemBuilder, SubmenuBuilder,
            HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
        },
        AppHandle, Emitter, Manager, Runtime, Window, WindowEvent,
    };

    use super::{Phase, MAIN_WINDOW};

    /// Puts the traffic lights back at `LIGHTS`. tao places them whenever its
    /// view draws, so this asks the view to draw: on the main thread, behind
    /// whatever was queued before it (a new title or appearance), and a draw
    /// follows the layout that moved them, so its placement is the one that
    /// holds. Cheap enough to ask after anything that may have moved them.
    pub fn relight<R: Runtime>(app: &AppHandle<R>) {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
                return;
            };
            let Ok(view) = window.ns_view() else {
                return;
            };
            // SAFETY: tao's content view, owned by the window we just got, on
            // the main thread.
            let view = unsafe { &*view.cast::<objc2_app_kit::NSView>() };
            view.setNeedsDisplay(true);
        });
        #[cfg(debug_assertions)]
        log_lights(app, "relight");
    }

    /// Debug builds log where the lights are a moment after anything that may
    /// have moved them: x from the close button's left edge to the zoom
    /// button's right, and the centre from the window's top.
    #[cfg(debug_assertions)]
    pub fn log_lights<R: Runtime>(app: &AppHandle<R>, why: &'static str) {
        let handle = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let inner = handle.clone();
            let _ = handle.run_on_main_thread(move || {
                use objc2_app_kit::{NSWindow, NSWindowButton};
                let Some(window) = inner.get_webview_window(MAIN_WINDOW) else {
                    return;
                };
                let Ok(ns_window) = window.ns_window() else {
                    return;
                };
                // SAFETY: the window's own NSWindow, on the main thread.
                let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };
                let (Some(close), Some(zoom)) = (
                    ns_window.standardWindowButton(NSWindowButton::CloseButton),
                    ns_window.standardWindowButton(NSWindowButton::ZoomButton),
                ) else {
                    return;
                };
                let height = ns_window.frame().size.height;
                let first = close.convertRect_toView(close.bounds(), None);
                let last = zoom.convertRect_toView(zoom.bounds(), None);
                eprintln!(
                    "chat: lights ({why}) x {:.1}-{:.1}, centre {:.1} from the top",
                    first.origin.x,
                    last.origin.x + last.size.width,
                    height - (first.origin.y + first.size.height / 2.0)
                );
            });
        });
    }

    /// The standard menu bar, plus View → Reload, Back and Forward. There is no
    /// address bar, so Back is how the privacy page returns to the chat.
    pub fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        let info = app.package_info();
        let about = AboutMetadata {
            name: Some(info.name.clone()),
            version: Some(info.version.to_string()),
            ..Default::default()
        };

        let app_menu = SubmenuBuilder::new(app, &info.name)
            .about(Some(about))
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        let file = SubmenuBuilder::new(app, "File").close_window().build()?;
        let edit = SubmenuBuilder::new(app, "Edit")
            .undo()
            .redo()
            .separator()
            .cut()
            .copy()
            .paste()
            .select_all()
            .build()?;
        let view = SubmenuBuilder::new(app, "View")
            .item(
                &MenuItemBuilder::with_id("reload", "Reload")
                    .accelerator("CmdOrCtrl+R")
                    .build(app)?,
            )
            .separator()
            .item(
                &MenuItemBuilder::with_id("back", "Back")
                    .accelerator("CmdOrCtrl+[")
                    .build(app)?,
            )
            .item(
                &MenuItemBuilder::with_id("forward", "Forward")
                    .accelerator("CmdOrCtrl+]")
                    .build(app)?,
            )
            .separator()
            .fullscreen()
            .build()?;
        let window = SubmenuBuilder::with_id(app, WINDOW_SUBMENU_ID, "Window")
            .minimize()
            .maximize()
            .separator()
            .bring_all_to_front()
            .build()?;
        let help = SubmenuBuilder::with_id(app, HELP_SUBMENU_ID, "Help").build()?;

        MenuBuilder::new(app)
            .items(&[&app_menu, &file, &edit, &view, &window, &help])
            .build()
    }

    pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
        let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let result = match event.id().as_ref() {
            "reload" => window.reload(),
            "back" => window.eval("history.back()"),
            "forward" => window.eval("history.forward()"),
            _ => Ok(()),
        };
        if let Err(error) = result {
            eprintln!("chat: menu action {:?} failed: {error}", event.id());
        }
    }

    /// Closing the window hides it; Quit quits. A full-screen window is not
    /// ordered out — that leaves an empty black Space behind — the app is
    /// hidden instead, which takes the Space with it until the Dock brings
    /// both back.
    ///
    /// A hidden window is closed: the page is told, so it can ask to be
    /// released once it has been closed a while (`super::release_window`).
    /// A hidden app is not — switching back to it must find its window.
    pub fn hide_on_close<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let app = window.app_handle();
            if window.is_fullscreen().unwrap_or(false) {
                if let Err(error) = app.hide() {
                    eprintln!("chat: could not hide the app: {error}");
                }
                return;
            }
            if let Err(error) = window.hide() {
                eprintln!("chat: could not hide the window: {error}");
                return;
            }
            *super::phase(app) = Phase::Closed;
            if let Err(error) = app.emit_to(MAIN_WINDOW, "window-closed", ()) {
                eprintln!("chat: could not tell the page it was closed: {error}");
            }
        }
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        // First, so a second launch — or a deep link that started one — hands
        // over to the running app before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app)
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(REMEMBERED)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .manage(PendingCode::default())
        .manage(FullScreen::default())
        .manage(MainWindow::default())
        .invoke_handler(tauri::generate_handler![
            session_token,
            set_session_token,
            clear_session_token,
            take_openrouter_code,
            set_window_theme,
            release_window
        ])
        .on_window_event(on_window_event);

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos::menu)
        .on_menu_event(macos::on_menu_event);

    builder
        .setup(|app| {
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                receive_links(&handle, &event.urls());
            });
            // An AppImage is never installed, so nothing told the desktop
            // about the scheme; the .deb and .rpm packages and the Windows
            // installers register it, and macOS reads it from the bundle.
            #[cfg(target_os = "linux")]
            if app.env().appimage.is_some() {
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("chat: could not register the link scheme: {error}");
                }
            }
            open_main_window(app.handle())?;
            // A link that launched the app arrived before anything listened.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                receive_links(app.handle(), &urls);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: WindowEvent::Destroyed,
                ..
            } if label == MAIN_WINDOW => on_main_window_destroyed(app),
            // A Mac app outlives its windows: a released window must not take
            // the app with it. Quit does not come this way.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => api.prevent_exit(),
            // The Dock icon, or opening the app again from Finder.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => show_main_window(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_the_bundled_ui_stays_in_the_window() {
        assert!(stays(&url("tauri://localhost/")));
        assert!(stays(&url("tauri://localhost/privacy")));
        assert!(stays(&url("http://tauri.localhost/index.html")));
        assert!(stays(&url("about:blank")));
        assert!(!stays(&url("https://chat.belayet.app/")));
        assert!(!stays(&url("https://openrouter.ai/auth?callback_url=x")));
        assert!(!stays(&url("tauri://evil.example/")));
        assert!(!stays(&url("http://localhost:3000/")));
        assert!(!stays(&url("file:///etc/passwd")));
    }

    #[test]
    fn only_web_and_mail_links_leave() {
        assert!(may_open_outside(&url("https://example.com/")));
        assert!(may_open_outside(&url("http://example.com/")));
        assert!(may_open_outside(&url("mailto:someone@example.com")));
        assert!(!may_open_outside(&url(
            "file:///Applications/Calculator.app"
        )));
        assert!(!may_open_outside(&url(
            "x-apple.systempreferences:com.apple.preference"
        )));
        assert!(!may_open_outside(&url("javascript:alert(1)")));
        assert!(!may_open_outside(&url("belayet-chat://openrouter?code=x")));
    }

    #[test]
    fn the_deep_link_carries_one_openrouter_code() {
        assert_eq!(
            openrouter_code(&url("belayet-chat://openrouter?code=abc%2B123")),
            Some("abc+123".into())
        );
        assert_eq!(openrouter_code(&url("belayet-chat://openrouter")), None);
        assert_eq!(
            openrouter_code(&url("belayet-chat://openrouter?code=")),
            None
        );
        assert_eq!(
            openrouter_code(&url("belayet-chat://elsewhere?code=abc")),
            None
        );
        assert_eq!(openrouter_code(&url("https://openrouter?code=abc")), None);
        let long = format!(
            "belayet-chat://openrouter?code={}",
            "x".repeat(MAX_CODE_CHARS + 1)
        );
        assert_eq!(openrouter_code(&url(&long)), None);
    }

    #[test]
    fn the_page_learns_the_api_and_platform() {
        let script = desktop_script();
        assert!(script.contains("__CHAT_DESKTOP__"));
        assert!(script.contains(&format!("\"api\":\"{API}\"")));
        assert!(script.contains(&format!("\"platform\":\"{}\"", std::env::consts::OS)));
    }
}
