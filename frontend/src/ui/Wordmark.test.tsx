import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Wordmark } from "./Wordmark";

describe("Wordmark", () => {
  it("renders the Piko wordmark", () => {
    render(<Wordmark />);
    expect(screen.getByText("Piko")).toBeInTheDocument();
  });
});
