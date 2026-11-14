// SPDX-License-Identifier: MIT
import { useState } from "react";

import type { ConversationMessage } from "../api";
import { sendFromInbox } from "../actions";
import type { ChatCard } from "../lib/chat-core";
import { useInboxView } from "./inbox-view-context";

/**
 * The options of a needs-you card as buttons (the card format is chat-core's `parseCard`). A click
 * answers the message with the option's text; once the thread holds that answer, the buttons give
 * way to it. The agent's pick leads and is named with its reason.
 */
export function CardOptions({
  m,
  card,
  answer,
}: {
  m: ConversationMessage;
  card: ChatCard;
  /** The person's reply to this card, once the thread holds one. */
  answer: string | null;
}) {
  const view = useInboxView();
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  if (answer !== null)
    return (
      <div className="ibx-card-opts" data-answered="true">
        <span>Answered: {answer}</span>
      </div>
    );
  const choose = async (option: string) => {
    if (sending) return;
    setSending(true);
    setFailed(null);
    await sendFromInbox({
      to: m.from,
      text: option,
      messages: view.messages,
      fallbackTeam: view.fallbackTeam,
      dir: view.dir,
      roles: view.roles,
      inReplyTo: m,
      quiet: true,
      onFailed: (why) => setFailed(why),
    });
    setSending(false);
  };
  return (
    <div className="ibx-card-opts" role="group" aria-label="Answer">
      {card.options.map((option) => (
        <button
          key={option}
          type="button"
          className={`ibx-chip${option === card.pick ? " primary" : ""}`}
          disabled={sending}
          onClick={() => void choose(option)}
        >
          {option}
        </button>
      ))}
      {card.pick && card.reason && <span className="ibx-card-why">{card.reason}</span>}
      {failed && (
        <span className="ibx-card-why" role="alert">
          Could not send: {failed}
        </span>
      )}
    </div>
  );
}
