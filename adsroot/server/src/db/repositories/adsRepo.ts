import { db } from "../client.js";

export interface AdRecord {
  id: number;
  title: string;
  imageUrl: string;
  targetUrl: string;
  summary: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

interface AdRow extends Omit<AdRecord, "isActive"> {
  isActive: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapAdRow(row: AdRow): AdRecord {
  return {
    ...row,
    isActive: Number(row.isActive) === 1,
  };
}

function normalizeAdInput(input: {
  title?: string;
  imageUrl?: string;
  targetUrl?: string;
  summary?: string;
  isActive?: boolean;
  sortOrder?: number;
}) {
  return {
    title: String(input.title ?? "").trim(),
    imageUrl: String(input.imageUrl ?? "").trim(),
    targetUrl: String(input.targetUrl ?? "").trim(),
    summary: String(input.summary ?? "").trim(),
    isActive: input.isActive === true,
    sortOrder:
      typeof input.sortOrder === "number" && Number.isFinite(input.sortOrder)
        ? Math.trunc(input.sortOrder)
        : 0,
  };
}

export function listAds(includeInactive = true): AdRecord[] {
  const whereClause = includeInactive ? "" : "WHERE is_active = 1";
  const rows = db
    .prepare(
      `SELECT
         id,
         title,
         image_url as imageUrl,
         target_url as targetUrl,
         summary,
         is_active as isActive,
         sort_order as sortOrder,
         created_at as createdAt,
         updated_at as updatedAt
       FROM ads
       ${whereClause}
       ORDER BY sort_order ASC, id DESC`,
    )
    .all() as AdRow[];
  return rows.map(mapAdRow);
}

export function findAdById(id: number): AdRecord | undefined {
  const row = db
    .prepare(
      `SELECT
         id,
         title,
         image_url as imageUrl,
         target_url as targetUrl,
         summary,
         is_active as isActive,
         sort_order as sortOrder,
         created_at as createdAt,
         updated_at as updatedAt
       FROM ads
       WHERE id = ?`,
    )
    .get(id) as AdRow | undefined;
  return row ? mapAdRow(row) : undefined;
}

export function createAd(input: {
  title?: string;
  imageUrl?: string;
  targetUrl?: string;
  summary?: string;
  isActive?: boolean;
  sortOrder?: number;
}): AdRecord {
  const normalized = normalizeAdInput(input);
  const timestamp = nowIso();
  const result = db
    .prepare(
      `INSERT INTO ads (
         title,
         image_url,
         target_url,
         summary,
         is_active,
         sort_order,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      normalized.title,
      normalized.imageUrl,
      normalized.targetUrl,
      normalized.summary,
      normalized.isActive ? 1 : 0,
      normalized.sortOrder,
      timestamp,
      timestamp,
    );
  return findAdById(Number(result.lastInsertRowid)) as AdRecord;
}

export function updateAd(
  id: number,
  input: {
    title?: string;
    imageUrl?: string;
    targetUrl?: string;
    summary?: string;
    isActive?: boolean;
    sortOrder?: number;
  },
): AdRecord | undefined {
  const current = findAdById(id);
  if (!current) {
    return undefined;
  }
  const merged = normalizeAdInput({
    title: input.title ?? current.title,
    imageUrl: input.imageUrl ?? current.imageUrl,
    targetUrl: input.targetUrl ?? current.targetUrl,
    summary: input.summary ?? current.summary,
    isActive: input.isActive ?? current.isActive,
    sortOrder: input.sortOrder ?? current.sortOrder,
  });
  db.prepare(
    `UPDATE ads
     SET
       title = ?,
       image_url = ?,
       target_url = ?,
       summary = ?,
       is_active = ?,
       sort_order = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    merged.title,
    merged.imageUrl,
    merged.targetUrl,
    merged.summary,
    merged.isActive ? 1 : 0,
    merged.sortOrder,
    nowIso(),
    id,
  );
  return findAdById(id);
}

export function deleteAd(id: number): boolean {
  const result = db.prepare("DELETE FROM ads WHERE id = ?").run(id);
  return result.changes > 0;
}
