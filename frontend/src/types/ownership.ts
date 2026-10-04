/**
 * 样带归属（外业队台账）。
 *
 * 背景：界线、保护区状态与站位归属归保护区管理站（sites / reefs）；
 * 样带布设与珊瑚覆盖归外业队（belts / corals / fishes）。两边各记各的，
 * 旧数据里样带本身没有归属礁区记录，v3 升级时按「当时所属站位 → 站位当时所属礁区」
 * 回填一版归属快照。
 *
 * 划转时「样带跟着站位走」：保护区管理站改站点位 reefId，外业队改本快照 reefId，
 * 两侧按站位编号（siteNo）对账，任何一侧对不上只挂起本侧。
 */

/** 外业队样带归属快照：一条样带一条 */
export interface BeltOwnership {
  /** 与样带 id 一一对应，同时作为主键，便于按样带直接取归属 */
  beltId: string
  /** 归属快照时样带所属站位（外业队侧记录） */
  siteId: string
  /** 站位编号快照，双方对账键，如 S-01 */
  siteNo: string
  /** 归属礁区：白化结论按此口径把样带计入礁区 */
  reefId: string
  /** 最近一次随划转更新的划转单 id；v3 回填或新布设样带为 null */
  lastTransferId: string | null
  createdAt: number
  updatedAt: number
}

/** 单侧（管理站 / 外业队）对账状态 */
export type SideStatus =
  | 'pending' // 建单：尚未对账
  | 'matched' // 对账通过：站位编号两侧对得上，等待执行划转
  | 'suspended' // 对不上：挂起等人定
  | 'applied' // 已划转
  | 'withdrawn' // 已撤回（只影响本侧，另一侧照旧）

/** 一侧对账结果（纯函数产物，不落库） */
export interface SideReconcileResult {
  status: SideStatus
  /** 命中的站位（管理站为 sites、外业队为归属快照聚合后的站位），挂起时可能为 null */
  siteId: string | null
  /** 本侧找到的候选站位数量（0 / 1 / 多个重复） */
  candidateCount: number
  /** 对不上时的原因，用于挂起面板提示 */
  reason: string
}

/** 划转单：记录一个站位编号从原礁区划到相邻礁区的双边进度 */
export interface SiteTransfer {
  id: string
  /** 对账键：站位编号，如 S-01 */
  siteNo: string
  /** 划出礁区（管理站界线口径） */
  fromReefId: string
  /** 划入礁区（相邻礁区） */
  toReefId: string
  /** 建单说明，如「核心区界线调整」 */
  remark: string

  /* ----- 保护区管理站侧（界线 / 站位归属） ----- */
  stationStatus: SideStatus
  /** 管理站侧命中 / 人工指定的站位 id */
  stationSiteId: string | null
  stationReason: string
  stationMatchedAt: number | null
  stationAppliedAt: number | null
  stationWithdrawnAt: number | null

  /* ----- 外业队侧（样带归属 / 珊瑚覆盖） ----- */
  fieldStatus: SideStatus
  /** 外业队侧命中 / 人工指定的站位 id（归属快照聚合） */
  fieldSiteId: string | null
  fieldReason: string
  fieldMatchedAt: number | null
  fieldAppliedAt: number | null
  fieldWithdrawnAt: number | null

  createdAt: number
  updatedAt: number
}

export const SIDE_STATUSES: SideStatus[] = ['pending', 'matched', 'suspended', 'applied', 'withdrawn']

/** 单侧状态中文文案与配色键（TransferStatusTag 消费） */
export const SIDE_STATUS_META: Record<SideStatus, { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'plain' }> = {
  pending: { label: '待对账', tone: 'info' },
  matched: { label: '已对账', tone: 'success' },
  suspended: { label: '已挂起', tone: 'danger' },
  applied: { label: '已划转', tone: 'success' },
  withdrawn: { label: '已撤回', tone: 'plain' }
}

/** 建单草稿 */
export interface TransferDraft {
  siteNo: string
  fromReefId: string
  toReefId: string
  remark: string
}

export function createEmptyTransferDraft(reefId = ''): TransferDraft {
  return { siteNo: '', fromReefId: reefId, toReefId: '', remark: '' }
}

/** 划转单整体进度（两张台账合并口径） */
export type TransferStage =
  | 'draft' // 两侧都还没对账
  | 'reconciling' // 至少一侧已对账但未划转完
  | 'done' // 两侧都已划转
  | 'suspended' // 任一侧挂起（等人定）
  | 'withdrawn' // 两侧都已撤回（单不再生效，可重新对账）

/**
 * 汇总两侧状态得到整单阶段。
 * 规则：任一侧挂起即判挂起（提示等人定）；两侧划转完为完成；
 * 两侧撤回为已撤回；有一侧动作过为对账中；都未对账为草稿。
 */
export function overallStage(t: SiteTransfer): TransferStage {
  const sides: SideStatus[] = [t.stationStatus, t.fieldStatus]
  if (sides.includes('suspended')) return 'suspended'
  if (sides.every((s) => s === 'applied')) return 'done'
  if (sides.every((s) => s === 'withdrawn')) return 'withdrawn'
  if (sides.every((s) => s === 'pending')) return 'draft'
  return 'reconciling'
}

export const TRANSFER_STAGE_META: Record<
  TransferStage,
  { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'plain' }
> = {
  draft: { label: '草稿', tone: 'info' },
  reconciling: { label: '对账 / 划转中', tone: 'warning' },
  done: { label: '划转完成', tone: 'success' },
  suspended: { label: '挂起待裁定', tone: 'danger' },
  withdrawn: { label: '整单已撤回', tone: 'plain' }
}
