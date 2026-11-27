// SPDX-License-Identifier: MIT
import { useEffect } from "react";
import { useTheme } from "next-themes";

import { TooltipProvider } from "@/components/ui/tooltip";
import type { ChatIdentity } from "@/features/workspace-chat/components/workspace-chat-body";
import { WorkspaceChatMessageRow } from "@/features/workspace-chat/components/workspace-chat-message-row";
import { useWorkspaceChat } from "@/features/workspace-chat/hooks/use-workspace-chat";
import { colourForHandle } from "@/features/workspace-chat/lib/role-colour";
import "@/features/workspace-chat/workspace-chat.css";
import { CHAT_MEDIA_WS, chatMediaFixtures } from "./chat-media-fixtures";

/**
 * `dev:mock` only: a workspace chat with one image post per media state (loaded with and
 * without text, KLIPY, tap to load from another machine or an unlisted host, loading, failed,
 * damaged, blocked), read through the real hook so a tapped Load runs to the image. For
 * screenshots and the critique. `?harness=chat-media[&theme=light|dark]`; each row carries
 * `data-state`.
 */

const IDENTITIES: Record<string, ChatIdentity> = {
  builder: { name: "Builder", color: colourForHandle("builder"), initials: "B" },
  reviewer: { name: "Reviewer", color: colourForHandle("reviewer"), initials: "R" },
  remote: { name: "Scout", color: colourForHandle("remote"), initials: "S", machine: "studio" },
};

const STATES = new Map(chatMediaFixtures().map((f) => [f.message.messageId, f.state]));

export function ChatMediaHarness() {
  const { setTheme } = useTheme();
  const themeParam = new URLSearchParams(window.location.search).get("theme");
  useEffect(() => {
    if (themeParam === "light" || themeParam === "dark") setTheme(themeParam);
  }, [themeParam, setTheme]);
  const chat = useWorkspaceChat(CHAT_MEDIA_WS);

  return (
    <TooltipProvider delayDuration={200}>
      <main className="ibx min-h-screen bg-[var(--background)] p-6">
        <section
          className="wc mx-auto max-w-[720px]"
          data-density="b"
          aria-label="Chat media states"
        >
          <div className="wc-body" role="log" aria-label="Workspace chat messages">
            {(chat.messages ?? []).map((message) => {
              const identity = IDENTITIES[message.from];
              return (
                <div key={message.messageId} data-state={STATES.get(message.messageId)}>
                  <WorkspaceChatMessageRow
                    identity={identity}
                    message={message}
                    isLead
                    isHuman={false}
                    avatarGlyph={identity?.initials ?? "?"}
                    roleColour={identity?.color ?? colourForHandle(message.from)}
                  />
                </div>
              );
            })}
          </div>
        </section>
      </main>
    </TooltipProvider>
  );
}
