import { describe, expect, it } from "vitest";

import { errorLabel, warningLabel } from "./utils";

describe("file status labels", () => {
  it("explains stable parser error codes", () => {
    expect(errorLabel("external_reference_not_allowed")).toContain("external");
    expect(errorLabel("nested_archive_not_allowed")).toContain("embedded");
    expect(errorLabel("invalid_ooxml")).toContain("damaged");
  });

  it("turns parser warning codes into user-facing copy", () => {
    expect(warningLabel("partial_content_not_extracted")).not.toContain("_");
    expect(warningLabel("external_links_not_extracted")).toContain("links");
    expect(warningLabel("animated_image_first_frame_only")).toContain("first frame");
  });
});
