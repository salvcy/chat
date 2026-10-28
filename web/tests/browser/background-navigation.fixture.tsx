"use client";

import { useEffect, useState } from "react";
import ChatSessions from "@/components/chat/ChatSessions";
import { setCredential } from "@/lib/credentials";
import { DEFAULT_SETTINGS } from "@/lib/types";
import type { DialMessage } from "@/lib/conversations";

type TestState = {
  saves: { id: string; messages: DialMessage[]; draft?: boolean; model: string }[];
  selections: string[];
  fail: boolean;
  block: boolean;
  release: (() => void)[];
};
declare global { interface Window { navigationTest: TestState } }
const testState: TestState = { saves: [], selections: [], fail: false, block: false, release: [] };
const saveTurn = async (input: {
  id: string; messages: DialMessage[]; draft?: boolean; settings: typeof DEFAULT_SETTINGS;
}) => {
  if (testState.block) await new Promise<void>((resolve) => testState.release.push(resolve));
  if (testState.fail) throw new Error("Test save failure");
  testState.saves.push({ ...input, model: input.settings.model });
};
const loadThread = async () => ({ messages: [], removed: new Set<string>() });
const noop = () => {};

export default function NavigationFixture() {
  const [active, setActive] = useState("a");
  const [loading, setLoading] = useState(false);
  const [retired, setRetired] = useState<ReadonlySet<string>>(new Set());
  const [mounted, setMounted] = useState(true);
  useEffect(() => {
    window.navigationTest = testState;
    // Synthetic test credential, held only in this isolated test page's heap.
    setCredential({ key: "navigation-test-only", source: "manual", label: null, connectedAt: 0 });
    return () => setCredential(null);
  }, []);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
    <nav>{["a", "b", "c"].map((id) =>
      <button key={id} onClick={() => {
        setActive(id);
        setLoading(true);
        setTimeout(() => setLoading(false), 150);
      }}>Open {id}</button>,
    )}
      <button onClick={() => setRetired(new Set(["a"]))}>Delete a</button>
      <button onClick={() => setMounted(false)}>Unmount account</button>
    </nav>
    <output data-active>{active}</output>
    {mounted && <ChatSessions activeId={active} retiredIds={retired} current={loading ? null : {
      conversationId: active,
      settings: { ...DEFAULT_SETTINGS, model: active === "b" ? "openai/gpt-4.1-mini" : "openai/gpt-4.1" },
      initialMessages: [], models: [], recentModels: [],
      onSettingsChange: noop, onRecent: noop, onOpenSwitcher: noop, onBranch: noop,
      saveTurn, loadThread, remoteVersion: 0,
      setActiveId: (id) => { testState.selections.push(id); setActive(id); },
      instructions: "", userName: "Navigation test",
    }}><p>Loading</p></ChatSessions>}
  </div>;
}
