import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("renders the React rebuild shell", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "iChat" })).toBeInTheDocument();
    expect(screen.getByText("React rebuild scaffold is ready.")).toBeInTheDocument();
  });
});
