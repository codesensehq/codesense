// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import { EditorBreadcrumbs } from "./editor-breadcrumbs";

function crumbs() {
  return screen.getByTestId("worktree-breadcrumbs");
}

describe("EditorBreadcrumbs", () => {
  it("shows the folders then the file for a POSIX path", () => {
    render(<EditorBreadcrumbs relPath="src/a/x.ts" absPath="/r/src/a/x.ts" scope={null} />);
    expect(crumbs()).toHaveTextContent("srcax.ts");
    expect(screen.getByText("x.ts")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
  });

  it("shows src \u203a x.ts for a Windows relative path", () => {
    render(
      <EditorBreadcrumbs
        relPath="src\\x.ts"
        absPath="C:\\Users\\a\\repo\\src\\x.ts"
        scope={null}
      />,
    );
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("x.ts")).toBeInTheDocument();
    expect(crumbs()).toHaveTextContent("srcx.ts");
    expect(crumbs()).not.toHaveTextContent("\\");
  });

  it("follows the file with the enclosing code scope", () => {
    render(
      <EditorBreadcrumbs relPath="src\\x.ts" absPath="C:\\r\\src\\x.ts" scope={["Foo", "bar"]} />,
    );
    expect(crumbs()).toHaveTextContent("srcx.tsFoobar");
  });
});
