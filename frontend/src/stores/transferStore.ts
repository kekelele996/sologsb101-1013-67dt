/**
 * 划转 store：维护站位划转双边台账（transfers）与外业队样带归属快照（ownership）。
 * 领域规则全部在 utils/transfer.ts；这里只做响应式订阅与薄封装。
 * 页面只读 store 状态，动作通过 utils/transfer.ts 落 IndexedDB，liveQuery 自动回推。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type { BeltOwnership, SiteTransfer, TransferDraft } from '@/types/ownership'
import { overallStage } from '@/types/ownership'
import {
  applyTransferSide,
  createTransfer,
  fieldSiteCandidates,
  reconcileTransferSide,
  removeTransfer,
  resolveSuspendedSide,
  stationSiteCandidates,
  withdrawTransferSide,
  type FieldSideSite
} from '@/utils/transfer'
import type { Site } from '@/types/site'

export const useTransferStore = defineStore('transfer', () => {
  const transfers = ref<SiteTransfer[]>([])
  const ownership = ref<BeltOwnership[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SiteTransfer>(() => db.transfers).subscribe((rows) => {
      transfers.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<BeltOwnership>(() => db.ownership).subscribe((rows) => {
      ownership.value = rows
    })
  }

  /** 全部划转单（按更新时间倒序） */
  const orderedTransfers = computed<SiteTransfer[]>(() =>
    [...transfers.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 待处理：任一侧挂起或两侧都还没划转完 */
  const pendingCount = computed(
    () => transfers.value.filter((t) => ['draft', 'reconciling', 'suspended'].includes(overallStage(t))).length
  )

  /** 挂起待裁定数量（两侧任一挂起即计） */
  const suspendedCount = computed(
    () => transfers.value.filter((t) => t.stationStatus === 'suspended' || t.fieldStatus === 'suspended').length
  )

  function transferById(id: string | null | undefined): SiteTransfer | null {
    if (!id) return null
    return transfers.value.find((item) => item.id === id) ?? null
  }

  /** beltId → 归属行，供覆盖度派生使用 */
  const ownershipByBelt = computed<Map<string, BeltOwnership>>(() => new Map(ownership.value.map((row) => [row.beltId, row])))

  async function create(draft: TransferDraft): Promise<SiteTransfer> {
    return createTransfer(draft)
  }

  async function reconcile(id: string, side: 'station' | 'field'): Promise<SiteTransfer> {
    return reconcileTransferSide(id, side)
  }

  async function apply(id: string, side: 'station' | 'field'): Promise<SiteTransfer> {
    return applyTransferSide(id, side)
  }

  async function withdraw(id: string, side: 'station' | 'field'): Promise<SiteTransfer> {
    return withdrawTransferSide(id, side)
  }

  async function resolve(id: string, side: 'station' | 'field', siteId: string): Promise<SiteTransfer> {
    return resolveSuspendedSide(id, side, siteId)
  }

  async function remove(id: string): Promise<void> {
    await removeTransfer(id)
  }

  async function stationCandidates(transfer: SiteTransfer): Promise<Array<Site & { inFromReef: boolean }>> {
    return stationSiteCandidates(transfer)
  }

  async function fieldCandidates(transfer: SiteTransfer): Promise<FieldSideSite[]> {
    return fieldSiteCandidates(transfer)
  }

  return {
    transfers,
    ownership,
    ready,
    error,
    orderedTransfers,
    pendingCount,
    suspendedCount,
    ownershipByBelt,
    start,
    transferById,
    create,
    reconcile,
    apply,
    withdraw,
    resolve,
    remove,
    stationCandidates,
    fieldCandidates
  }
})
