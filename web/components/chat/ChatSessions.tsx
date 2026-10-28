"use client";

import { Component, type ComponentProps, type ReactNode } from "react";
import ChatView from "./ChatView";

type ChatProps = Omit<ComponentProps<typeof ChatView>, "active" | "onHoldChange">;
type Session = { props: ChatProps; holding: boolean };
type Props = {
  activeId: string;
  current: ChatProps | null;
  retiredIds: ReadonlySet<string>;
  children: ReactNode;
};
type State = { sessions: Session[] };

/**
 * A request belongs to its conversation, not to whichever history is visible.
 * Keep only the visible session and sessions with work a teardown would lose.
 * Hidden sessions use display:none: React Activity would suspend the effects
 * that checkpoint and publish the stream. Nothing is written to local storage.
 */
export default class ChatSessions extends Component<Props, State> {
  state: State = { sessions: [] };

  static getDerivedStateFromProps(props: Props, state: State): State {
    const sessions = state.sessions.filter(({ props: chat, holding }) =>
      !props.retiredIds.has(chat.conversationId) &&
      (holding || chat.conversationId === props.activeId),
    );
    const current = props.current;
    if (current && !props.retiredIds.has(current.conversationId)) {
      const index = sessions.findIndex(({ props: chat }) =>
        chat.conversationId === current.conversationId,
      );
      if (index < 0) sessions.push({ props: current, holding: false });
      else sessions[index] = { ...sessions[index], props: current };
    }
    return { sessions };
  }

  private onHoldChange = (id: string, holding: boolean) => {
    this.setState(({ sessions }) => {
      const session = sessions.find(({ props }) => props.conversationId === id);
      if (!session || session.holding === holding) return null;
      return {
        sessions: sessions.map((entry) => entry === session ? { ...entry, holding } : entry),
      };
    });
  };

  render() {
    const { activeId, children } = this.props;
    const visible = this.state.sessions.some(({ props }) => props.conversationId === activeId);
    return <>
      {this.state.sessions.map(({ props }) => {
        const active = props.conversationId === activeId;
        return (
          <div
            key={props.conversationId}
            data-chat-session={props.conversationId}
            hidden={!active}
            className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
          >
            <ChatView {...props} active={active} onHoldChange={this.onHoldChange} />
          </div>
        );
      })}
      {!visible && children}
    </>;
  }
}
