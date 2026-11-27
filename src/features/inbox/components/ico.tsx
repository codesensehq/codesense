// SPDX-License-Identifier: MIT
import type { LucideIcon } from "lucide-react";

/** A Lucide glyph at the inbox's two sizes (15px, 13px small) and stroke weight. */
export function Ico({ icon: Icon, sm }: { icon: LucideIcon; sm?: boolean }) {
  return <Icon className={sm ? "ibx-ico sm" : "ibx-ico"} strokeWidth={1.75} aria-hidden />;
}
