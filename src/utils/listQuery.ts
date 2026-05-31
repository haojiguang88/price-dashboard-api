export const normalizeQueryText = (value: unknown) => {
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  if (value === undefined || value === null) return "";
  return String(value).trim();
};

export const parsePagination = (pageInput: unknown, pageSizeInput: unknown) => {
  const parsedPage = Number.parseInt(normalizeQueryText(pageInput) || "1", 10);
  const parsedPageSize = Number.parseInt(normalizeQueryText(pageSizeInput) || "10", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const pageSize = Number.isFinite(parsedPageSize)
    ? Math.min(Math.max(parsedPageSize, 1), 200)
    : 10;

  return {
    page,
    pageSize,
    limit: pageSize,
    offset: (page - 1) * pageSize
  };
};

export const toLikePattern = (value: string) => `%${value}%`;
