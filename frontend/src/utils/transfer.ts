/**
 * 界线划转编排：保护站划转与外业划转两步各自独立提交。
 *
 * 关键规则（对应业务口径）：
 * - 样带跟着站位换归属：外业按站位编号把样带的 attribReefId 改到新礁区。
 * - 两边按站位编号对账：查无此号 / 编号跨礁区重号 / 归属礁区对不上，只把本侧样带挂起。
 * - 保护站划转这一步出问题：只撤回这一步（sites.reefId 回滚），外业那份原样不动。
 * - 外业对不上：只挂起本侧（belts.attribStatus=suspended），保护站已划转结果保留。
 */
import { db, createId } from '@/utils/db'
import { nextTransferNo, summarizeTransferStatus } from '@/utils/attribution'
import type { Belt } from '@/types/belt'
import type { ReefTransfer, TransferItem, TransferStatus, TransferStepStatus } from '@/types/transfer'

export interface CreateTransferInput {
  operator: string
  remark: string
  items: Array<{ siteId: string; toReefId: string }>
}

export interface CreateTransferResult {
  transfer: ReefTransfer
  /** 保护站侧失败条目（整批回滚后，这些条目标 failed） */
  managerFailed: Array<{ siteId: string; reason: string }>
}

/**
 * 发起并执行划转：
 * 第一步保护站划转整体一个事务，任一条目失败则整批回滚（只回滚这一步）；
 * 第二步外业划转在保护站划转成功的前提下逐条独立处理，对不上的只挂起本侧。
 */
export async function createAndApplyTransfer(input: CreateTransferInput): Promise<CreateTransferResult> {
  const now = Date.now()
  const reefs = await db.reefs.toArray()
  const reefIds = new Set(reefs.map((reef) => reef.id))

  // 组装条目并做保护站侧预检（不改数据）
  const managerFailed: Array<{ siteId: string; reason: string }> = []
  const items: TransferItem[] = []

  for (const line of input.items) {
    const site = await db.sites.get(line.siteId)
    if (!site) {
      managerFailed.push({ siteId: line.siteId, reason: '保护站台账中找不到该站位' })
      items.push({
        siteId: line.siteId,
        siteNo: '—',
        fromReefId: '',
        toReefId: line.toReefId,
        managerStatus: 'failed',
        fieldStatus: 'pending',
        movedBeltCount: 0,
        suspendedBeltCount: 0,
        note: '保护站划转失败：站位不存在'
      })
      continue
    }
    if (!reefIds.has(line.toReefId)) {
      managerFailed.push({ siteId: line.siteId, reason: `划入礁区 ${line.toReefId} 不存在` })
      items.push({
        siteId: line.siteId,
        siteNo: site.no,
        fromReefId: site.reefId,
        toReefId: line.toReefId,
        managerStatus: 'failed',
        fieldStatus: 'pending',
        movedBeltCount: 0,
        suspendedBeltCount: 0,
        note: '保护站划转失败：目标礁区不存在'
      })
      continue
    }
    if (site.reefId === line.toReefId) {
      managerFailed.push({ siteId: line.siteId, reason: `站位 ${site.no} 本就在目标礁区，无需划转` })
      items.push({
        siteId: line.siteId,
        siteNo: site.no,
        fromReefId: site.reefId,
        toReefId: line.toReefId,
        managerStatus: 'failed',
        fieldStatus: 'pending',
        movedBeltCount: 0,
        suspendedBeltCount: 0,
        note: '保护站划转失败：站位已在目标礁区'
      })
      continue
    }
    items.push({
      siteId: site.id,
      siteNo: site.no,
      fromReefId: site.reefId,
      toReefId: line.toReefId,
      managerStatus: 'pending',
      fieldStatus: 'pending',
      movedBeltCount: 0,
      suspendedBeltCount: 0,
      note: ''
    })
  }

  const validItems = items.filter((item) => item.managerStatus === 'pending')

  // 第一步：保护站划转，单事务；抛错则整个事务回滚，外业侧完全不执行。
  if (validItems.length > 0) {
    try {
      await db.transaction('rw!', [db.sites, db.transfers], async () => {
        const stamp = Date.now()
        for (const item of validItems) {
          const updated = await db.sites.update(item.siteId, { reefId: item.toReefId, updatedAt: stamp })
          if (updated === 0) throw new Error(`站位 ${item.siteNo} 更新失败，回滚保护站划转`)
        }
      })
      validItems.forEach((item) => {
        item.managerStatus = 'applied'
      })
    } catch (error) {
      // 事务已整体回滚：只撤回保护站这一步，外业那份保持原样，全部条目维持/标记 pending→failed
      validItems.forEach((item) => {
        item.managerStatus = 'failed'
        item.note = `保护站划转已整体回滚：${(error as Error).message}`
      })
    }
  }

  // 第二步：外业划转。仅处理保护站已划转成功的条目，逐条独立，对不上只挂起本侧。
  const appliedItems = items.filter((item) => item.managerStatus === 'applied')
  for (const item of appliedItems) {
    await applyFieldStep(item)
  }

  const status: TransferStatus = summarizeTransferStatus(items)
  const existing = await db.transfers.toArray()
  const transfer: ReefTransfer = {
    id: createId('tr'),
    no: nextTransferNo(existing),
    operator: input.operator.trim() || '保护区管理站',
    remark: input.remark.trim(),
    items,
    status,
    createdAt: now,
    updatedAt: Date.now()
  }
  await db.transfers.put(transfer)
  return { transfer, managerFailed }
}

/**
 * 外业划转单条站位：样带跟着站位走。
 * 以划转站位（保护站主键）为锚，只处理物理挂在该站位上的外业样带：
 * - 外业账站位编号与该站位编号一致：归属改到新礁区（跟转）；
 * - 外业账站位编号对不上 / 站位已缺失：只在本侧挂起这些样带，等人定。
 * 不触碰其它站位（含跨礁区同编号）的样带，互不连坐。
 */
async function applyFieldStep(item: TransferItem): Promise<void> {
  try {
    const site = await db.sites.get(item.siteId)
    if (!site || site.reefId !== item.toReefId || site.no !== item.siteNo) {
      item.fieldStatus = 'failed'
      item.note = '外业划转前复核保护站账失败：站位或其新归属与划转单不一致，本侧未改动'
      return
    }

    const onPhysicalSite = await db.belts.where('siteId').equals(item.siteId).toArray()
    const followers: Belt[] = []
    const stragglers: Belt[] = []
    onPhysicalSite.forEach((belt) => {
      // 两账按站位编号对账：编号一致才允许跟转，否则本侧挂起
      if (belt.attribSiteNo === item.siteNo) followers.push(belt)
      else stragglers.push(belt)
    })

    const stamp = Date.now()
    if (followers.length > 0) {
      await db.belts
        .where('id')
        .anyOf(followers.map((belt) => belt.id))
        .modify((belt) => {
          belt.attribReefId = item.toReefId
          belt.attribStatus = 'active'
          belt.attribReason = `界线划转：随站位 ${item.siteNo} 由原礁区划入新礁区`
          belt.attribUpdatedAt = stamp
          belt.updatedAt = stamp
        })
    }
    if (stragglers.length > 0) {
      await suspendBelts(
        stragglers,
        `划转站位 ${item.siteNo} 时，该样带外业账站位编号（${stragglers
          .map((belt) => belt.attribSiteNo)
          .join('、')}）对不上，本侧挂起等人定`
      )
    }

    item.movedBeltCount = followers.length
    item.suspendedBeltCount = stragglers.length
    item.fieldStatus = 'applied'
    item.note =
      stragglers.length > 0
        ? `${followers.length} 条样带随站位移交新礁区；${stragglers.length} 条编号对不上已在本侧挂起`
        : `${followers.length} 条样带随站位移交新礁区`
  } catch (error) {
    // 外业这一条出错：只挂起本侧，保护站划转结果与其它站位不受影响
    item.fieldStatus = 'failed'
    item.note = `外业划转异常，本侧挂起：${(error as Error).message}`
  }
}

async function suspendBelts(belts: Belt[], reason: string): Promise<void> {
  if (belts.length === 0) return
  const stamp = Date.now()
  await db.belts
    .where('id')
    .anyOf(belts.map((belt) => belt.id))
    .modify((belt) => {
      belt.attribStatus = 'suspended'
      belt.attribReason = reason
      belt.attribUpdatedAt = stamp
    })
}

/**
 * 撤回划转：只撤回保护站这一步（sites.reefId 恢复到 fromReefId）。
 * 外业队那份样带归属原样保留，两账差异由对账页列出等人定，不做自动回改。
 */
export async function revertTransfer(transferId: string): Promise<ReefTransfer> {
  return db.transaction('rw!', [db.sites, db.transfers], async () => {
    const transfer = await db.transfers.get(transferId)
    if (!transfer) throw new Error('划转单不存在')
    const stamp = Date.now()
    let revertedAny = false
    for (const item of transfer.items) {
      if (item.managerStatus !== 'applied') continue
      const updated = await db.sites.update(item.siteId, { reefId: item.fromReefId, updatedAt: stamp })
      if (updated === 0) throw new Error(`站位 ${item.siteNo} 恢复失败，回滚本次撤回`)
      item.managerStatus = 'reverted' as TransferStepStatus
      // 外业侧状态原样保留（applied/failed 都不动），仅追加说明
      item.note = `${item.note ? `${item.note}；` : ''}保护站已撤回本步划转，外业归属保持原样，待人工对账`
      revertedAny = true
    }
    if (revertedAny) {
      transfer.status = 'reverted'
      transfer.updatedAt = stamp
      await db.transfers.put(transfer)
    }
    return transfer
  })
}

/**
 * 人工裁定：解除一条挂起样带，指定其最终归属礁区与站位编号（外业侧本侧操作）。
 * 保护站账不改；裁定后若与保护站账一致即重新计入礁区结论。
 */
export async function resolveSuspendedBelt(
  beltId: string,
  resolution: { reefId: string; siteNo: string; reason: string }
): Promise<void> {
  const stamp = Date.now()
  const updated = await db.belts.update(beltId, {
    attribReefId: resolution.reefId,
    attribSiteNo: resolution.siteNo,
    attribStatus: 'active',
    attribReason: `人工裁定解除挂起：${resolution.reason}`,
    attribUpdatedAt: stamp,
    updatedAt: stamp
  } as never)
  if (updated === 0) throw new Error('样带不存在或已被删除')
}

/** 重新执行外业侧仍挂起/失败的站位（保护站划转已生效、人工核对编号后） */
export async function retryFieldItem(transferId: string, siteId: string): Promise<void> {
  const transfer = await db.transfers.get(transferId)
  if (!transfer) throw new Error('划转单不存在')
  const item = transfer.items.find((entry) => entry.siteId === siteId)
  if (!item) throw new Error('划转单中找不到该站位')
  if (item.managerStatus !== 'applied') {
    throw new Error('保护站划转未生效，不能重跑外业侧')
  }
  await applyFieldStep(item)
  transfer.status = summarizeTransferStatus(transfer.items)
  transfer.updatedAt = Date.now()
  await db.transfers.put(transfer)
}

/** 仅统计当前挂起样带数，供导航徽标使用 */
export async function countSuspendedBelts(): Promise<number> {
  return db.belts.where('attribStatus').equals('suspended').count()
}
