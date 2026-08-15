import { describe, expect, it } from "vitest";

import { tableToTsv } from "./tableTsv";

describe("tableToTsv", () => {
  it("preserves empty, multilingual, multiline, tab, and quoted cell values", () => {
    const table = document.createElement("table");
    table.innerHTML = [
      "<thead><tr><th>名称</th><th>空值</th><th>多行</th><th>制表</th><th>引号</th></tr></thead>",
      '<tbody><tr><td>中文</td><td></td><td>第一行<br>Second line</td><td>左\t右</td><td>他说 "好"</td></tr></tbody>',
    ].join("");

    expect(tableToTsv(table)).toBe(
      '名称\t空值\t多行\t制表\t引号\n中文\t\t"第一行\nSecond line"\t"左\t右"\t"他说 ""好"""',
    );
  });
});
