/**
 * 划转流程 Node 验证脚本（不入构建产物）：
 * 用 fake-indexeddb 模拟浏览器 IndexedDB，走 db/transfer 领域服务，验证：
 * 1) 初始归属按当时礁区回填；
 * 2) 两侧按站位编号对账，匹配 / 不匹配（挂起单侧）；
 * 3) 单侧执行只改本侧；白化结论归属跟随外业队侧；
 * 4) 只撤回管理站侧，外业队照旧；只撤回外业队侧，管理站照旧；
 * 5) 旧（v2 式）数据无归属时，导入备份按当时礁区回填。
 */
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import assert from 'node:assert/strict'

// 必须在 import db 模块（Dexie 加载时探测 IndexedDB）之前注入全局，因此后续全部动态导入。
// @ts-expect-error - node 环境注入浏览器 API
globalThis.indexedDB = new IDBFactory()
// @ts-expect-error - node 环境注入浏览器 API
globalThis.IDBKeyRange = IDBKeyRange
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED', reason)
  process.exit(2)
})

const { db, initDatabase } = await import('./src/utils/db.ts')
const {
  applyTransferSide,
  createTransfer,
  reconcileStationSide,
  reconcileFieldSide,
  reconcileTransferSide,
  aggregateFieldSites,
  withdrawTransferSide
} = await import('./src/utils/transfer.ts')
const { buildBackupPayload, buildCoverageLines, buildReefSummaries, backfillOwnership, validateBackup } = await import(
  './src/utils/export.ts'
)

let failures = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${name}:`, (error as Error).message)
  }
}

async function main(): Promise<void> {
  await initDatabase()

  // 1) 初始归属：清澜湾 site_ql_02 上的 belt_ql02_a 归属 reef_ql01
  const ownershipBefore = await db.ownership.toArray()
  const ownerQl02 = ownershipBefore.find((o) => o.beltId === 'belt_ql02_a')
  check('新库归属快照按当时礁区回填', () => {
    assert(ownershipBefore.length === 5, `应有 5 条归属，实际 ${ownershipBefore.length}`)
    assert(ownerQl02?.reefId === 'reef_ql01', 'belt_ql02_a 初始应归 reef_ql01')
    assert(ownerQl02?.siteNo === 'S-02', 'siteNo 快照应为 S-02')
  })

  // 2) 纯函数对账：匹配
  const sites = await db.sites.toArray()
  const owners = await db.ownership.toArray()
  const draft = { siteNo: 'S-02', fromReefId: 'reef_ql01', toReefId: 'reef_yr02', remark: '界线调整' }
  check('管理站按站位编号在划出礁区内对账命中', () => {
    const r = reconcileStationSide(sites, draft)
    assert(r.status === 'matched' && r.siteId === 'site_ql_02', '应命中 site_ql_02')
  })
  check('外业队按归属快照对账命中', () => {
    const r = reconcileFieldSide(owners, draft)
    assert(r.status === 'matched' && r.siteId === 'site_ql_02', '应命中 site_ql_02')
  })

  // 对不上：错误编号 → 两侧都挂起且给原因
  const bad = { ...draft, siteNo: 'S-99' }
  check('管理站找不到编号 → 挂起', () => {
    const r = reconcileStationSide(sites, bad)
    assert(r.status === 'suspended' && r.siteId === null, '应挂起且无站位')
  })
  check('外业队找不到编号 → 挂起', () => {
    const r = reconcileFieldSide(owners, bad)
    assert(r.status === 'suspended' && r.reason.includes('S-99'), '应挂起且原因带编号')
  })

  // 外业聚合站点位
  check('外业归属聚合站位', () => {
    const agg = aggregateFieldSites(owners)
    const s02 = agg.find((s) => s.siteId === 'site_ql_02')
    assert(s02?.reefId === 'reef_ql01' && s02.beltCount === 1, 'S-02 应 1 条样带归 reef_ql01')
  })

  // 3) 建单 → 两侧对账 → 只执行管理站侧
  const transfer = await createTransfer(draft)
  const recStation = await reconcileTransferSide(transfer.id, 'station')
  const recField = await reconcileTransferSide(transfer.id, 'field')
  check('两侧对账通过', () => {
    assert(recStation.stationStatus === 'matched', '管理站应 matched')
    assert(recField.fieldStatus === 'matched', '外业队应 matched')
  })

  await applyTransferSide(transfer.id, 'station')
  const siteAfterStation = await db.sites.get('site_ql_02')
  const ownerAfterStation = await db.ownership.get('belt_ql02_a')
  check('管理站划转只改站点位，外业归属不动', () => {
    assert(siteAfterStation?.reefId === 'reef_yr02', '站点位应已改 reef_yr02')
    assert(ownerAfterStation?.reefId === 'reef_ql01', '外业归属应仍 reef_ql01（未动）')
  })

  // 白化结论：此时样带仍按外业归属计入原礁区 reef_ql01
  let payload = await buildBackupPayload()
  let lines = buildCoverageLines(payload)
  let line = lines.find((l) => l.beltId === 'belt_ql02_a')
  let summaries = buildReefSummaries(payload, lines)
  const qlSummaryBefore = summaries.find((s) => s.reefId === 'reef_ql01')
  check('仅管理站划转：白化结论仍把样带算在原礁区（外业未动）', () => {
    assert(line?.reefId === 'reef_ql01', '结论归属仍应是 reef_ql01')
    assert(qlSummaryBefore?.beltCount === 3, `原礁区应仍含 3 条样带，实际 ${qlSummaryBefore?.beltCount}`)
  })

  // 4) 执行外业队侧 → 样带跟着站位换归属
  await applyTransferSide(transfer.id, 'field')
  const ownerAfterField = await db.ownership.get('belt_ql02_a')
  check('外业划转：样带归属礁区改到相邻礁区', () => {
    assert(ownerAfterField?.reefId === 'reef_yr02', '归属应改 reef_yr02')
    assert(ownerAfterField?.lastTransferId === transfer.id, '应记录划转单 id')
  })
  payload = await buildBackupPayload()
  lines = buildCoverageLines(payload)
  line = lines.find((l) => l.beltId === 'belt_ql02_a')
  summaries = buildReefSummaries(payload, lines)
  const qlSummaryAfter = summaries.find((s) => s.reefId === 'reef_ql01')
  const yrSummaryAfter = summaries.find((s) => s.reefId === 'reef_yr02')
  check('两侧划转后：白化结论把样带计入新礁区，原礁区不再背', () => {
    assert(line?.reefId === 'reef_yr02', '结论归属应为 reef_yr02')
    assert(qlSummaryAfter?.beltCount === 2, `原礁区应剩 2 条样带，实际 ${qlSummaryAfter?.beltCount}`)
    assert(yrSummaryAfter?.beltCount === 2, `新礁区应含 2 条样带，实际 ${yrSummaryAfter?.beltCount}`)
    const ql01Line = lines.find((l) => l.beltId === 'belt_ql01_a')
    assert(ql01Line?.reefId === 'reef_ql01', '未划转样带仍归原礁区')
  })

  // 5a) 只撤回管理站侧：站点位回退；外业归属照旧
  await withdrawTransferSide(transfer.id, 'station')
  const siteAfterWithdrawStation = await db.sites.get('site_ql_02')
  const ownerAfterWithdrawStation = await db.ownership.get('belt_ql02_a')
  const row5a = (await db.transfers.get(transfer.id))
  check('只撤回管理站侧：站点位回退、外业归属照旧', () => {
    assert(siteAfterWithdrawStation?.reefId === 'reef_ql01', '站点位应恢复 reef_ql01')
    assert(ownerAfterWithdrawStation?.reefId === 'reef_yr02', '外业归属应仍 reef_yr02（照旧）')
    assert(row5a.stationStatus === 'withdrawn' && row5a.fieldStatus === 'applied', '状态：站撤回/外业已划转')
  })

  // 再撤外业队侧：归属回退；管理站侧状态照旧（withdrawn）
  await withdrawTransferSide(transfer.id, 'field')
  const ownerAfterWithdrawField = await db.ownership.get('belt_ql02_a')
  const row5b = (await db.transfers.get(transfer.id))
  check('只撤回外业队侧：归属回原礁区、管理站侧照旧', () => {
    assert(ownerAfterWithdrawField?.reefId === 'reef_ql01', '外业归属应恢复 reef_ql01')
    assert(row5b.stationStatus === 'withdrawn' && row5b.fieldStatus === 'withdrawn', '两侧均 withdrawn')
  })

  // 撤回后可重新对账、再次划转（状态机通畅）
  const againStation = await reconcileTransferSide(transfer.id, 'station')
  check('撤回后可重新对账', () => {
    assert(againStation.stationStatus === 'matched', '管理站应重新 matched')
  })

  // 6) 旧备份（无 ownership/transfers）：校验通过 + 按当时礁区回填
  const currentPayload = await buildBackupPayload()
  const legacy = {
    app: 'gbcoralbelt',
    dbVersion: 2,
    exportedAt: new Date().toISOString(),
    reefs: currentPayload.reefs,
    sites: currentPayload.sites,
    belts: currentPayload.belts,
    corals: currentPayload.corals,
    fishes: currentPayload.fishes
  }
  const validation = validateBackup(legacy)
  check('旧备份（无归属表）校验通过', () => {
    assert(validation.ok, `应通过：${validation.errors.join('，')}`)
  })
  const backfilled = backfillOwnership(validation.payload!)
  check('旧备份导入前按当时礁区回填归属', () => {
    assert(backfilled.ownership.length === currentPayload.belts.length, '应每条样带一条归属')
    const o = backfilled.ownership.find((x) => x.beltId === 'belt_ql02_a')
    assert(o?.reefId === 'reef_ql01' && o.siteNo === 'S-02', '回填礁区与站位编号正确')
    assert(backfilled.transfers.length === 0, '旧备份无划转单')
  })

  console.log(failures === 0 ? '\n全部通过 ✅' : `\n${failures} 项失败 ❌`)
  if (failures > 0) process.exit(1)
  process.exit(0)
}

void main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
