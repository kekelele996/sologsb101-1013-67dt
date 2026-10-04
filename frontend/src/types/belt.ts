/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/**
 * 外业队归属账状态：
 * - active：归属有效，白化结论按 attribReefId 计入对应礁区
 * - suspended：按站位编号与保护站台账对不上，挂起等人定，暂不计入任何礁区结论
 */
export type BeltAttribStatus = 'active' | 'suspended'

/** 样带：站位上布设的普查样带 */
export interface Belt {
  id: string
  /** 所属站位（物理挂点，划转时不改） */
  siteId: string
  /** 样带编号，如 T-01 */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  /** 外业队归属账：样带当时归属的站位编号（两边按此对账） */
  attribSiteNo: string
  /** 外业队归属账：样带当时归属的礁区 id（白化结论口径） */
  attribReefId: string
  /** 外业队归属账状态 */
  attribStatus: BeltAttribStatus
  /** 挂起/裁定原因，供人工核对 */
  attribReason: string
  /** 最近一次归属变动时间（0 表示由历史数据回填） */
  attribUpdatedAt: number
  createdAt: number
  updatedAt: number
}

/** 样带布设草稿（存于 beltStore） */
export interface BeltDraft {
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: ''
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
