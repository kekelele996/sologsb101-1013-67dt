/**
 * 站位划转领域服务：管理站侧（界线 / 站位归属）与外业队侧（样带归属 / 珊瑚覆盖）
 * 双边按站位编号（siteNo）独立对账、独立执行、独立撤回。
 *
 * 不变量：
 * - 每侧四个动作 reconcile / apply / withdraw / pick 只改自己侧字段，报错整事务回滚，
 *   另一侧照旧；
 * - 管理站划转改 sites.reefId；外业队划转只改 ownership（与 belts.siteId 快照跟随），
 *   白化结论此后按 ownership.reefId 把样带计入新礁区；
 * - 对不上（找不到 / 编号重复 / 目标礁区缺失）→ 只挂起本侧（status=suspended），不动数据，等人定；
 * - 旧数据没有归属记录，v3 升级 / 导入旧备份时按当时礁区回填一版（见 db.ts、export.ts）。
 */
import { createId, db } from '@/utils/db'
import type { Site } from '@/types/site'
import type { BeltOwnership, SideReconcileResult, SideStatus, SiteTransfer, TransferDraft } from '@/types/ownership'

type Side = 'station' | 'field'

export class TransferRuleError extends Error {}

const nowTs = (): number => Date.now()

/* ------------------------------- 纯函数对账 ------------------------------- */

/** 管理站侧：按站位编号在「划出礁区」内查站位，0 / 多个即挂起 */
export function reconcileStationSide(
  sites: Site[],
  transfer: Pick<SiteTransfer, 'siteNo' | 'fromReefId' | 'toReefId'>
): SideReconcileResult {
  const keyword = transfer.siteNo.trim()
  const candidates = sites.filter(
    (site) => site.no.trim() === keyword && site.reefId === transfer.fromReefId
  )
  if (candidates.length === 1) {
    return { status: 'matched', siteId: candidates[0].id, candidateCount: 1, reason: '' }
  }
  if (candidates.length === 0) {
    return {
      status: 'suspended',
      siteId: null,
      candidateCount: 0,
      reason: `管理站在划出礁区内找不到编号「${keyword}」的站位，请人工核对界线与编号`
    }
  }
  return {
    status: 'suspended',
    siteId: null,
    candidateCount: candidates.length,
    reason: `管理站划出礁区内编号「${keyword}」对应 ${candidates.length} 个站位，编号重复，请人工指定`
  }
}

/** 外业队侧：按归属快照聚合出站位（siteId + siteNo + reefId），在「划出礁区」内查 */
export interface FieldSideSite {
  siteId: string
  siteNo: string
  reefId: string
  beltCount: number
}

export function aggregateFieldSites(ownership: BeltOwnership[]): FieldSideSite[] {
  const map = new Map<string, FieldSideSite>()
  ownership.forEach((row) => {
    // 同站位样带始终整站一起划转，各归属行 reefId/siteNo 一致；首行建桶即可
    const bucket = map.get(row.siteId) ?? { siteId: row.siteId, siteNo: row.siteNo, reefId: row.reefId, beltCount: 0 }
    bucket.beltCount += 1
    map.set(row.siteId, bucket)
  })
  return Array.from(map.values())
}

export function reconcileFieldSide(
  ownership: BeltOwnership[],
  transfer: Pick<SiteTransfer, 'siteNo' | 'fromReefId' | 'toReefId'>
): SideReconcileResult {
  const keyword = transfer.siteNo.trim()
  const aggregated = aggregateFieldSites(ownership)
  const candidates = aggregated.filter(
    (site) => site.siteNo.trim() === keyword && site.reefId === transfer.fromReefId
  )
  if (candidates.length === 1) {
    return { status: 'matched', siteId: candidates[0].siteId, candidateCount: 1, reason: '' }
  }
  if (candidates.length === 0) {
    return {
      status: 'suspended',
      siteId: null,
      candidateCount: 0,
      reason: `外业队台账中找不到归属在划出礁区、编号「${keyword}」的站位样带，请核对站位编号或等管理站侧数据`
    }
  }
  return {
    status: 'suspended',
    siteId: null,
    candidateCount: candidates.length,
    reason: `外业队台账中编号「${keyword}」对应 ${candidates.length} 个归属站位，请人工指定`
  }
}

/* ------------------------------- 持久化动作 ------------------------------- */

/** 建划转单：两侧初始 pending，只落单据本身 */
export async function createTransfer(draft: TransferDraft): Promise<SiteTransfer> {
  const siteNo = draft.siteNo.trim()
  if (!siteNo) throw new TransferRuleError('请填写站位编号')
  if (!draft.fromReefId || !draft.toReefId) throw new TransferRuleError('请选择划出与划入礁区')
  if (draft.fromReefId === draft.toReefId) throw new TransferRuleError('划出礁区与划入礁区不能相同')
  const now = nowTs()
  const row: SiteTransfer = {
    id: createId('trf'),
    siteNo,
    fromReefId: draft.fromReefId,
    toReefId: draft.toReefId,
    remark: draft.remark.trim(),
    stationStatus: 'pending',
    stationSiteId: null,
    stationReason: '',
    stationMatchedAt: null,
    stationAppliedAt: null,
    stationWithdrawnAt: null,
    fieldStatus: 'pending',
    fieldSiteId: null,
    fieldReason: '',
    fieldMatchedAt: null,
    fieldAppliedAt: null,
    fieldWithdrawnAt: null,
    createdAt: now,
    updatedAt: now
  }
  await db.transfers.put(row)
  return row
}

async function loadTransfer(id: string): Promise<SiteTransfer> {
  const row = await db.transfers.get(id)
  if (!row) throw new TransferRuleError('划转单不存在或已被删除')
  return row
}

/** 单侧状态机守卫：已划转须先撤回，已对账不必重复对账 */
function assertReconcilable(status: SideStatus, sideLabel: string): void {
  if (status === 'applied') {
    throw new TransferRuleError(`${sideLabel}侧已划转，如需调整请先撤回本侧`)
  }
}

function assertApplicable(status: SideStatus, sideLabel: string): void {
  if (status !== 'matched') {
    throw new TransferRuleError(`${sideLabel}侧当前为「${status}」，需先对账通过才能划转`)
  }
}

function assertWithdrawable(status: SideStatus, sideLabel: string): void {
  if (status !== 'applied') {
    throw new TransferRuleError(`${sideLabel}侧尚未划转，无需撤回`)
  }
}

/** 单侧重新对账（纯状态更新；对不上直接挂起本侧） */
export async function reconcileTransferSide(id: string, side: Side): Promise<SiteTransfer> {
  return db.transaction('rw', [db.transfers, db.sites, db.ownership], async () => {
    const transfer = await loadTransfer(id)
    if (side === 'station') {
      assertReconcilable(transfer.stationStatus, '管理站')
      const result = reconcileStationSide(await db.sites.toArray(), transfer)
      transfer.stationSiteId = result.siteId
      transfer.stationReason = result.reason
      transfer.stationStatus = result.status
      transfer.stationMatchedAt = result.status === 'matched' ? nowTs() : null
    } else {
      assertReconcilable(transfer.fieldStatus, '外业队')
      const result = reconcileFieldSide(await db.ownership.toArray(), transfer)
      transfer.fieldSiteId = result.siteId
      transfer.fieldReason = result.reason
      transfer.fieldStatus = result.status
      transfer.fieldMatchedAt = result.status === 'matched' ? nowTs() : null
    }
    transfer.updatedAt = nowTs()
    await db.transfers.put(transfer)
    return transfer
  })
}

/** 人工裁定：挂起侧指定站位后即视为对账通过（等人定 → 已对账） */
export async function resolveSuspendedSide(id: string, side: Side, siteId: string): Promise<SiteTransfer> {
  return db.transaction('rw', [db.transfers, db.sites, db.ownership], async () => {
    const transfer = await loadTransfer(id)
    if (!siteId) throw new TransferRuleError('请先指定站位')
    if (side === 'station') {
      if (transfer.stationStatus !== 'suspended') throw new TransferRuleError('仅挂起中的管理站侧可人工裁定')
      const site = await db.sites.get(siteId)
      if (!site) throw new TransferRuleError('指定的管理站站位不存在')
      transfer.stationSiteId = site.id
      transfer.stationReason = `人工裁定站位 ${site.no}（${site.id}）`
      transfer.stationStatus = 'matched'
      transfer.stationMatchedAt = nowTs()
    } else {
      if (transfer.fieldStatus !== 'suspended') throw new TransferRuleError('仅挂起中的外业队侧可人工裁定')
      const owned = await db.ownership.where('siteId').equals(siteId).first()
      if (!owned) throw new TransferRuleError('指定站位在开外业队台账中没有样带归属记录')
      transfer.fieldSiteId = siteId
      transfer.fieldReason = `人工裁定外业站位 ${owned.siteNo}（${siteId}）`
      transfer.fieldStatus = 'matched'
      transfer.fieldMatchedAt = nowTs()
    }
    transfer.updatedAt = nowTs()
    await db.transfers.put(transfer)
    return transfer
  })
}

/** 执行单侧划转：管理站改站点位；外业队改样带归属（样带跟着站位换归属）。
 * 执行前置条件对不上（站位没了 / 已在目标礁区 / 归属空了）→ 本侧转挂起等人定，不报错回滚。 */
export async function applyTransferSide(id: string, side: Side): Promise<SiteTransfer> {
  return db.transaction(
    'rw',
    [db.transfers, db.sites, db.belts, db.ownership],
    async () => {
      const transfer = await loadTransfer(id)
      const ts = nowTs()
      if (side === 'station') {
        assertApplicable(transfer.stationStatus, '管理站')
        const siteId = transfer.stationSiteId as string
        const site = await db.sites.get(siteId)
        if (!site) {
          transfer.stationStatus = 'suspended'
          transfer.stationReason = '对账命中的管理站站位已不存在，挂起等人定'
        } else if (site.reefId === transfer.toReefId) {
          // 站位已经在划入礁区（可能由其他划转单完成）：本侧直接视为已划转，不再重复改
          transfer.stationStatus = 'applied'
          transfer.stationAppliedAt = ts
          transfer.stationReason = '执行时站位已在划入礁区，按现状记为已划转'
        } else if (site.reefId !== transfer.fromReefId) {
          transfer.stationStatus = 'suspended'
          transfer.stationReason = `执行时站位已不在划出礁区（现属 ${site.reefId}），界线可能被他处调整，挂起等人定`
        } else {
          await db.sites.update(siteId, { reefId: transfer.toReefId, updatedAt: ts })
          transfer.stationStatus = 'applied'
          transfer.stationAppliedAt = ts
          transfer.stationReason = ''
        }
      } else {
        assertApplicable(transfer.fieldStatus, '外业队')
        const siteId = transfer.fieldSiteId as string
        const rows = await db.ownership.where('siteId').equals(siteId).toArray()
        if (rows.length === 0) {
          transfer.fieldStatus = 'suspended'
          transfer.fieldReason = '外业队侧该站位下已没有样带归属记录，挂起等人定'
        } else {
          const beltIds = rows.map((row) => row.beltId)
          // 样带跟着站位换归属：只翻外业队归属礁区；站点位移动由管理站侧划转负责。
          await db.ownership
            .where('beltId')
            .anyOf(beltIds)
            .modify((row: BeltOwnership) => {
              row.reefId = transfer.toReefId
              row.lastTransferId = transfer.id
              row.updatedAt = ts
            })
          transfer.fieldStatus = 'applied'
          transfer.fieldAppliedAt = ts
          transfer.fieldReason = ''
        }
      }
      transfer.updatedAt = ts
      await db.transfers.put(transfer)
      return transfer
    }
  )
}

/** 撤回单侧划转：只回滚本侧数据，另一侧照旧 */
export async function withdrawTransferSide(id: string, side: Side): Promise<SiteTransfer> {
  return db.transaction(
    'rw',
    [db.transfers, db.sites, db.belts, db.ownership],
    async () => {
      const transfer = await loadTransfer(id)
      const ts = nowTs()
      if (side === 'station') {
        assertWithdrawable(transfer.stationStatus, '管理站')
        const siteId = transfer.stationSiteId as string
        const site = await db.sites.get(siteId)
        if (site && site.reefId === transfer.toReefId) {
          await db.sites.update(siteId, { reefId: transfer.fromReefId, updatedAt: ts })
        }
        transfer.stationStatus = 'withdrawn'
        transfer.stationWithdrawnAt = ts
        transfer.stationReason = '管理站侧已撤回，站位归属恢复原礁区；外业队侧数据不变'
      } else {
        assertWithdrawable(transfer.fieldStatus, '外业队')
        const siteId = transfer.fieldSiteId as string
        // 仅回滚本单据翻过归属的样带；其他划转单已处理的样带保持不动
        await db.ownership
          .where('siteId')
          .equals(siteId)
          .modify((row: BeltOwnership) => {
            if (row.lastTransferId === transfer.id) {
              row.reefId = transfer.fromReefId
              row.updatedAt = ts
            }
          })
        transfer.fieldStatus = 'withdrawn'
        transfer.fieldWithdrawnAt = ts
        transfer.fieldReason = '外业队侧已撤回，样带归属恢复原礁区；管理站侧界线不变'
      }
      transfer.updatedAt = ts
      await db.transfers.put(transfer)
      return transfer
    }
  )
}

/** 删除划转单（仅整单两侧都不在 applied 时允许，避免删掉后无法回滚） */
export async function removeTransfer(id: string): Promise<void> {
  const transfer = await loadTransfer(id)
  if (transfer.stationStatus === 'applied' || transfer.fieldStatus === 'applied') {
    throw new TransferRuleError('存在已划转侧时不能删除单据，请先撤回对应侧')
  }
  await db.transfers.delete(id)
}

/** 挂起侧人工裁定用的候选站位 */
export async function stationSiteCandidates(
  transfer: SiteTransfer
): Promise<Array<Site & { inFromReef: boolean }>> {
  const keyword = transfer.siteNo.trim()
  const rows = await db.sites.toArray()
  return rows
    .filter((site) => site.no.trim() === keyword)
    .map((site) => ({ ...site, inFromReef: site.reefId === transfer.fromReefId }))
}

export async function fieldSiteCandidates(transfer: SiteTransfer): Promise<FieldSideSite[]> {
  const keyword = transfer.siteNo.trim()
  const aggregated = aggregateFieldSites(await db.ownership.toArray())
  return aggregated.filter((site) => site.siteNo.trim() === keyword)
}
