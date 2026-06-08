import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("renders the iChat wordmark", () => {
    render(<Wordmark />);
    expect(screen.getByText("iChat")).toBeInTheDocument();
  });
});
