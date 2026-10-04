/**
 * 保护区界线划转单（跨方协同）
 *
 * 两方各记各的账：
 * - 保护站台账（sites.reefId）：界线、保护区状态、站位归属
 * - 外业队台账（belts.attrib*）：样带布设与珊瑚覆盖
 *
 * 划转分两步，各自独立提交、互不连坐：
 * 1. 保护站划转（manager）：改 sites.reefId。失败/撤回只回滚这一步，外业那份原样保留。
 * 2. 外业划转（field）：按站位编号对账，样带跟着站位换归属；对不上的只在本侧挂起。
 */
import type { Belt } from '@/types/belt'

/** 单步划转状态 */
export type TransferStepStatus = 'pending' | 'applied' | 'reverted' | 'failed'

/** 单个划转站位（一条划转单可含多个站位，逐条对账、互不连坐） */
export interface TransferItem {
  /** 保护站站位主键 */
  siteId: string
  /** 对账键：站位编号，如 S-01 */
  siteNo: string
  /** 划出礁区 id */
  fromReefId: string
  /** 划入礁区 id */
  toReefId: string
  /** 保护站侧状态 */
  managerStatus: TransferStepStatus
  /** 外业队侧状态 */
  fieldStatus: TransferStepStatus
  /** 外业侧结果说明：跟转样带数、挂起样带数与原因 */
  movedBeltCount: number
  suspendedBeltCount: number
  note: string
}

/** 划转单整体状态 */
export type TransferStatus = 'pending' | 'applied' | 'partial' | 'reverted'

/** 界线划转单 */
export interface ReefTransfer {
  id: string
  /** 划转单编号，如 TR-20261004-001 */
  no: string
  /** 发起单位（保护区管理站） */
  operator: string
  remark: string
  items: TransferItem[]
  status: TransferStatus
  createdAt: number
  updatedAt: number
}

/** 外业对账差异类型（对不上先挂起等人定） */
export type ReconIssueKind =
  | 'manager-site-missing' // 站位编号在保护站台账查无此号
  | 'manager-site-ambiguous' // 站位编号在多个礁区重号，无法唯一对账
  | 'reef-mismatch' // 外业账归属礁区与保护站账不一致
  | 'site-missing' // 物理样带挂的站位已不存在
  | 'orphan-site-no' // 外业账站位编号下没有样带（仅提示）

/** 一条外业对账结果（按样带） */
export interface ReconRow {
  beltId: string
  beltNo: string
  siteId: string
  siteNo: string
  managerReefId: string
  fieldReefId: string
  /** 是否对得上：对得上才计入礁区结论 */
  matched: boolean
  status: Belt['attribStatus']
  issue: ReconIssueKind | null
  detail: string
}

export const TRANSFER_STEP_LABELS: Record<TransferStepStatus, string> = {
  pending: '待划转',
  applied: '已划转',
  reverted: '已撤回',
  failed: '划转失败'
}

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  pending: '待处理',
  applied: '双方已划转',
  partial: '部分挂起',
  reverted: '保护站已撤回'
}

export const RECON_ISSUE_LABELS: Record<ReconIssueKind, string> = {
  'manager-site-missing': '保护站账无此站位编号',
  'manager-site-ambiguous': '站位编号跨礁区重号',
  'reef-mismatch': '两账归属礁区不一致',
  'site-missing': '样带挂载站位缺失',
  'orphan-site-no': '该站位编号下外业无样带'
}
