function visibleCellText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLBRElement) return "\n";
  return Array.from(node.childNodes, visibleCellText).join("");
}

function encodeTsvCell(cell: HTMLTableCellElement) {
  const value = visibleCellText(cell).replace(/\r\n?/g, "\n").trim();
  return /["\t\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function tableToTsv(table: HTMLTableElement) {
  return Array.from(table.rows)
    .map((row) =>
      Array.from(row.cells)
        .map(encodeTsvCell)
        .join("\t"),
    )
    .join("\n");
}
