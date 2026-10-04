/**
 * 划转/对账/回填流程冒烟测试（内存 IndexedDB，不依赖浏览器）。
 * 用 esbuild 打包后 node 运行：见 scripts: smoke:build + smoke:run。
 */
import 'fake-indexeddb/auto'
import { db, resetDatabase, DB_VERSION } from '@/utils/db'
import {
  createAndApplyTransfer,
  revertTransfer,
  resolveSuspendedBelt,
  retryFieldItem
} from '@/utils/transfer'
import { reconcileBelts } from '@/utils/attribution'
import { buildBackupPayload, buildCoverageLines, buildReefSummaries } from '@/utils/export'

let failures = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    console.log(`  ✅ ${message}`)
  } else {
    failures += 1
    console.error(`  ❌ ${message}`)
  }
}

async function main(): Promise<void> {
  await db.open()
  await resetDatabase()

  const reefs = await db.reefs.toArray()
  const sites = await db.sites.toArray()
  const belts = await db.belts.toArray()

  console.log(`结构版本 v${DB_VERSION}`)
  assert(DB_VERSION === 3, '当前结构版本为 v3')
  assert(reefs.length === 3, `播种 3 个礁区（实际 ${reefs.length}）`)
  assert(belts.every((belt) => belt.attribStatus === 'active'), '播种样带归属账全部 active')
  assert(
    belts.every((belt) => belt.attribSiteNo && belt.attribReefId),
    '播种样带都回填了站位编号与礁区'
  )

  const ql01 = reefs.find((reef) => reef.id === 'reef_ql01')!
  const yr02 = reefs.find((reef) => reef.id === 'reef_yr02')!
  const dz03 = reefs.find((reef) => reef.id === 'reef_dz03')!
  const siteQl01 = sites.find((site) => site.id === 'site_ql_01')! // S-01，清澜湾，2 条样带，编号与外业一致
  const siteQl02 = sites.find((site) => site.id === 'site_ql_02')! // S-02，编号唯一

  console.log('\n— 场景 A：唯一编号站位 S-02 清澜湾 → 大洲岛，样带应跟随 —')
  const transferA = await createAndApplyTransfer({
    operator: '保护区管理站',
    remark: '界线调整A',
    items: [{ siteId: siteQl02.id, toReefId: dz03.id }]
  })
  const itemA = transferA.transfer.items[0]
  assert(itemA.managerStatus === 'applied', 'A 保护站侧 applied')
  assert(itemA.fieldStatus === 'applied', 'A 外业侧 applied')
  assert(itemA.movedBeltCount === 1, `A 跟转样带 1 条（实际 ${itemA.movedBeltCount}）`)
  assert(itemA.suspendedBeltCount === 0, 'A 无挂起')
  const beltQl02 = (await db.belts.where('siteId').equals(siteQl02.id).toArray())[0]
  assert(beltQl02.attribReefId === dz03.id, 'A 样带归属账已改到新礁区')
  const movedSite = await db.sites.get(siteQl02.id)
  assert(movedSite!.reefId === dz03.id, 'A 保护站站位归属已改')

  console.log('\n— 场景 B：重号站位 S-01 清澜湾 → 永兴岛，样带随本站位走，不波及同编号它礁区 —')
  const transferB = await createAndApplyTransfer({
    operator: '保护区管理站',
    remark: '界线调整B（编号跨礁区重号）',
    items: [{ siteId: siteQl01.id, toReefId: yr02.id }]
  })
  const itemB = transferB.transfer.items[0]
  assert(itemB.managerStatus === 'applied', 'B 保护站侧 applied（保护站账以主键为准）')
  const beltsOnQl01 = await db.belts.where('siteId').equals(siteQl01.id).toArray()
  // 以物理站位为锚、按站位编号对账：本站位 2 条样带编号一致 → 跟转；永兴岛/大洲岛同名 S-01 不波及
  assert(itemB.movedBeltCount === 2, `B 跟转样带 2 条（实际 ${itemB.movedBeltCount}）`)
  assert(itemB.suspendedBeltCount === 0, `B 无挂起（实际 ${itemB.suspendedBeltCount}）`)
  assert(beltsOnQl01.every((belt) => belt.attribStatus === 'active'), 'B 清澜湾 S-01 样带 active')
  assert(beltsOnQl01.every((belt) => belt.attribReefId === yr02.id), 'B 样带归属已随站位到永兴岛')
  const yrBelts = await db.belts.where('siteId').equals('site_yr_01').toArray()
  assert(yrBelts.every((belt) => belt.attribReefId === yr02.id && belt.attribStatus === 'active'), 'B 永兴岛本岛 S-01 样带未被波及')
  const movedSiteB = await db.sites.get(siteQl01.id)
  assert(movedSiteB!.reefId === yr02.id, 'B 保护站站位已在新礁区')

  console.log('\n— 对账与礁区结论：划走样带不再算原礁区 —')
  let payload = await buildBackupPayload()
  const lines = buildCoverageLines(payload)
  const lineQl02 = lines.find((line) => line.beltId === beltQl02.id)!
  assert(lineQl02.reefId === dz03.id, 'A 样带结论计入大洲岛（不再算清澜湾）')
  assert(!lineQl02.pending, 'A 样带非挂起')
  for (const belt of beltsOnQl01) {
    const line = lines.find((item) => item.beltId === belt.id)!
    assert(line.reefId === yr02.id && !line.pending, `${belt.id} 样带结论计入永兴岛`)
  }
  const summaries = buildReefSummaries(payload, lines)
  const sumDz = summaries.find((item) => item.reefId === dz03.id)!
  assert(sumDz.beltCount === 2, `大洲岛结论含 2 条样带（原有 1 + 划入 1，实际 ${sumDz.beltCount}）`)
  const sumYr = summaries.find((item) => item.reefId === yr02.id)!
  assert(sumYr.beltCount === 3, `永兴岛结论含 3 条样带（原有 1 + 划入 2，实际 ${sumYr.beltCount}）`)
  const sumQl = summaries.find((item) => item.reefId === ql01.id)!
  assert(sumQl.beltCount === 0, `清澜湾结论样带 0 条（S-02、S-01 均已划走，实际 ${sumQl.beltCount}）`)

  console.log('\n— 场景 C：撤回划转 B，只回滚保护站这一步，外业那份原样 → 两账错位挂起 —')
  await revertTransfer(transferB.transfer.id)
  const revertedSite = await db.sites.get(siteQl01.id)
  assert(revertedSite!.reefId === ql01.id, 'C 保护站站位恢复到原礁区')
  const beltsOnQl01After = await db.belts.where('siteId').equals(siteQl01.id).toArray()
  assert(
    beltsOnQl01After.every((belt) => belt.attribReefId === yr02.id && belt.attribStatus === 'active'),
    'C 外业归属原样保留（仍记永兴岛，未自动回改）'
  )
  payload = await buildBackupPayload()
  const linesAfterRevert = buildCoverageLines(payload)
  assert(
    beltsOnQl01After.every((belt) => {
      const line = linesAfterRevert.find((item) => item.beltId === belt.id)!
      return line.pending && line.reefId === ''
    }),
    'C 两账错位样带不计入任何礁区结论（等人定）'
  )

  console.log('\n— 场景 D：人工裁定解除错位样带（确认回清澜湾），重新计入原礁区 —')
  const targetBelt = beltsOnQl01After[0]
  await resolveSuspendedBelt(targetBelt.id, {
    reefId: ql01.id,
    siteNo: 'S-01',
    reason: '撤回后人工确认该样带仍属清澜湾 S-01'
  })
  let recon = reconcileBelts(await db.belts.toArray(), await db.sites.toArray())
  let targetRow = recon.find((row) => row.beltId === targetBelt.id)!
  assert(targetRow.matched && targetRow.managerReefId === ql01.id, 'D 裁定后两账重新对得上，计入清澜湾')

  console.log('\n— 场景 D2：外业账编号与保护站对不上的样带只本侧挂起 —')
  // 人为制造一条编号对不上的样带：把永兴岛样带外业编号改错后划转其站位不合适，
  // 直接构造：选大洲岛站位 S-01，先把其样带外业编号改成 S-99，再划转该站，应挂起
  const dzSite = sites.find((site) => site.id === 'site_dz_01')!
  const dzBelt = (await db.belts.where('siteId').equals(dzSite.id).toArray())[0]
  await db.belts.update(dzBelt.id, { attribSiteNo: 'S-99', attribUpdatedAt: Date.now() })
  const transferD2 = await createAndApplyTransfer({
    operator: '保护区管理站',
    remark: '编号对不上',
    items: [{ siteId: dzSite.id, toReefId: yr02.id }]
  })
  const itemD2 = transferD2.transfer.items[0]
  assert(itemD2.managerStatus === 'applied', 'D2 保护站划转成功')
  assert(itemD2.movedBeltCount === 0, `D2 无跟转（实际 ${itemD2.movedBeltCount}）`)
  assert(itemD2.suspendedBeltCount === 1, `D2 1 条本侧挂起（实际 ${itemD2.suspendedBeltCount}）`)
  const d2Belt = await db.belts.get(dzBelt.id)
  assert(d2Belt!.attribStatus === 'suspended' && d2Belt!.attribReefId === dz03.id, 'D2 挂起样带外业归属未被擅改')
  // 人工改回正确编号后，可重跑外业侧
  await resolveSuspendedBelt(dzBelt.id, { reefId: yr02.id, siteNo: 'S-01', reason: '编号更正为 S-01，随站位到永兴岛' })
  recon = reconcileBelts(await db.belts.toArray(), await db.sites.toArray())
  targetRow = recon.find((row) => row.beltId === dzBelt.id)!
  assert(targetRow.matched, 'D2 裁定更正编号后重新计入')

  console.log('\n— 场景 E：保护站划转失败只回滚保护站，外业不动 —')
  const beforeE = await db.belts.toArray()
  const transferE = await createAndApplyTransfer({
    operator: '保护区管理站',
    remark: '失败单',
    items: [{ siteId: 'site_not_exist', toReefId: dz03.id }]
  })
  assert(transferE.transfer.items[0].managerStatus === 'failed', 'E 失败条目标记 failed')
  const afterE = await db.belts.toArray()
  assert(afterE.length === beforeE.length, 'E 外业样带数量未变')
  assert(
    JSON.stringify(afterE.map((b) => [b.id, b.attribReefId, b.attribStatus])) ===
      JSON.stringify(beforeE.map((b) => [b.id, b.attribReefId, b.attribStatus])),
    'E 外业归属账完全未改动'
  )

  console.log('\n— 场景 F：retryFieldItem 可重跑外业侧 —')
  // 取 B 单（已撤回保护站），重跑应因保护站未生效而报错
  let threw = false
  try {
    await retryFieldItem(transferB.transfer.id, siteQl01.id)
  } catch {
    threw = true
  }
  assert(threw, 'F 保护站已撤回时禁止重跑外业侧')

  console.log(failures === 0 ? '\n全部冒烟断言通过 ✅' : `\n有 ${failures} 条断言失败 ❌`)
  if (failures > 0) process.exitCode = 1
  await db.close()
}

void main()
