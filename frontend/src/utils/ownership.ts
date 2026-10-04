/**
 * 样带归属口径工具：白化结论按外业队归属快照（ownership.reefId）计入礁区；
 * 旧数据 / 缺少归属行时回退到「样带 → 站位 → 礁区」的管理站界线口径。
 */
import type { BeltOwnership } from '@/types/ownership'

/** beltId → 归属行索引 */
export function buildOwnershipIndex(rows: BeltOwnership[]): Map<string, BeltOwnership> {
  return new Map(rows.map((row) => [row.beltId, row]))
}

/** 取样带的归属礁区：优先外业队归属快照，缺记录时回退到站位所属礁区 */
export function reefIdOfBelt(
  beltId: string,
  fallbackReefId: string | null | undefined,
  index: Map<string, BeltOwnership>
): string {
  const owned = index.get(beltId)
  if (owned && owned.reefId) return owned.reefId
  return fallbackReefId ?? ''
}

/** 取样带归属站位（外业队划转后可能与 belts.siteId 不同），缺记录时回退到样带当前站位 */
export function siteIdOfBelt(
  beltId: string,
  fallbackSiteId: string | null | undefined,
  index: Map<string, BeltOwnership>
): string {
  const owned = index.get(beltId)
  if (owned && owned.siteId) return owned.siteId
  return fallbackSiteId ?? ''
}
