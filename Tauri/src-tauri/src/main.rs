// No console window behind the app in a Windows release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    chat_lib::run()
}
