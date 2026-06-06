import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Project runs without `test.globals`, so RTL's automatic afterEach(cleanup)
// is not registered. Register it explicitly to isolate DOM between tests.
afterEach(() => {
  cleanup();
});
