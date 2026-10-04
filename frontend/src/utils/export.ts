/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import type { BeltOwnership, SiteTransfer } from '@/types/ownership'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名（v3 起含外业队归属快照与划转台账） */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes', 'ownership', 'transfers'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

/** v2 及更早备份没有后两张表，导入时需要补 */
const LEGACY_KEYS: ReadonlyArray<BackupKey> = ['reefs', 'sites', 'belts', 'corals', 'fishes']

export type CountMap = Record<BackupKey, number>

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, ownership, transfers] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.ownership.toArray(),
    db.transfers.toArray()
  ])
  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    reefs,
    sites,
    belts,
    corals,
    fishes,
    ownership,
    transfers
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  // 五张老表必须齐备；ownership / transfers 为 v3 新增，老备份可缺（导入时补回填）
  for (const key of LEGACY_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: obj.reefs ?? [],
    sites: obj.sites ?? [],
    belts: obj.belts ?? [],
    corals: obj.corals ?? [],
    fishes: obj.fishes ?? [],
    ownership: Array.isArray(obj.ownership) ? obj.ownership : [],
    transfers: Array.isArray(obj.transfers) ? obj.transfers : []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length,
    ownership: payload.ownership.length,
    transfers: payload.transfers.length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload()
  const fileName = `${DB_NAME}-backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 旧备份没有归属记录：按「当时礁区」回填一版归属快照，口径与 v3 升级一致。
 * 已有 ownership 的备份原样保留。
 */
export function backfillOwnership(payload: BackupPayload): BackupPayload {
  if (payload.ownership.length > 0) return payload
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const stamp = Date.now()
  const ownership: BeltOwnership[] = payload.belts.map((belt) => {
    const site = siteById.get(belt.siteId)
    return {
      beltId: belt.id,
      siteId: belt.siteId,
      siteNo: site?.no ?? '',
      reefId: site?.reefId ?? '',
      lastTransferId: null,
      createdAt: belt.createdAt ?? stamp,
      updatedAt: belt.updatedAt ?? stamp
    }
  })
  return { ...payload, ownership }
}

/** 导入快照：overwrite=true 先清空全部表，否则按主键合并 */
export async function importBackup(payloadIn: BackupPayload, overwrite: boolean): Promise<CountMap> {
  // 旧版本备份导入时按当时礁区补一版样带归属
  const payload = backfillOwnership(payloadIn)
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.ownership, db.transfers],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      await db.ownership.bulkPut(payload.ownership)
      await db.transfers.bulkPut(payload.transfers)
    }
  )
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payloadIn: BackupPayload): BackupPayload {
  const payload = backfillOwnership(payloadIn)
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return { ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return { ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId
  }))
  // 归属快照跟样带一起重映射；划转单涉及外部对账与既有站位，追加导入时不复制
  const ownership: BeltOwnership[] = payload.ownership.map((row) => ({
    ...row,
    beltId: beltMap.get(row.beltId) ?? row.beltId,
    siteId: siteMap.get(row.siteId) ?? row.siteId,
    reefId: reefMap.get(row.reefId) ?? row.reefId,
    lastTransferId: null
  }))
  const transfers: SiteTransfer[] = []
  return { ...payload, reefs, sites, belts, corals, fishes, ownership, transfers }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/** 按样带生成覆盖度结论行（礁区归属按外业队样带归属快照口径） */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(payload.reefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(payload.sites.map((site) => [site.id, site]))
  const ownershipByBelt = new Map(payload.ownership.map((row) => [row.beltId, row]))
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return payload.belts
    .map((belt) => {
      const stationSite = siteById.get(belt.siteId)
      const owned = ownershipByBelt.get(belt.id)
      // 样带跟着站位换归属：优先外业归属快照的站位 / 礁区，缺记录回退管理站界线
      const site = (owned ? siteById.get(owned.siteId) : undefined) ?? stationSite
      const reefId = owned?.reefId || stationSite?.reefId || ''
      const reef = reefById.get(reefId)
      const corals = coralsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          corals.length === 0
            ? '该样带尚未录入珊瑚记录'
            : grade === '无'
              ? `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，未见白化`
              : `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级 */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

/**
 * 按礁区汇总：直接以样带结论行（已按外业归属计入对应礁区）聚合，
 * 保证划转后划走的样带不再算在原礁区头上。
 */
export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  return payload.reefs.map((reef) => {
    const lines4Reef = lines.filter((line) => line.reefId === reef.id)
    const siteIds = new Set(lines4Reef.map((line) => line.siteId))
    const avgBleachIndex =
      lines4Reef.length === 0
        ? 0
        : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
    return {
      reefId: reef.id,
      reefName: reef.name,
      protectStatus: reef.protectStatus,
      siteCount: siteIds.size,
      beltCount: lines4Reef.length,
      coralCount: lines4Reef.reduce((sum, line) => sum + line.coralCount, 0),
      coverCmTotal: round(
        lines4Reef.reduce((sum, line) => sum + line.coverCmTotal, 0),
        1
      ),
      avgBleachIndex,
      grade: bleachGrade(avgBleachIndex),
      fishTotal: lines4Reef.reduce((sum, line) => sum + line.fishTotal, 0)
    }
  })
}
