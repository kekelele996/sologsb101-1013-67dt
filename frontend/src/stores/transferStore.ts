/**
 * 界线划转 store：维护划转单列表、挂起样带数，封装两阶段划转与撤回/裁定。
 * 保护站账（sites）与外业账（belts）的读写规则见 utils/transfer.ts。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type { ReefTransfer } from '@/types/transfer'
import {
  createAndApplyTransfer,
  resolveSuspendedBelt,
  revertTransfer,
  retryFieldItem
} from '@/utils/transfer'

export const useTransferStore = defineStore('transfer', () => {
  const transfers = ref<ReefTransfer[]>([])
  const suspendedBeltIds = ref<string[]>([])
  const ready = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<ReefTransfer>(() => db.transfers).subscribe((rows) => {
      transfers.value = rows.sort((a, b) => b.createdAt - a.createdAt)
      ready.value = true
    })
    // 挂起状态来自外业账 belts，单独订阅
    watchTable<Belt>(() => db.belts).subscribe((rows) => {
      suspendedBeltIds.value = rows
        .filter((row) => row.attribStatus === 'suspended')
        .map((row) => row.id)
    })
  }

  const suspendedCount = computed(() => suspendedBeltIds.value.length)
  const hasActiveTransfer = computed(
    () => transfers.value.some((item) => item.status === 'pending' || item.status === 'partial')
  )

  function transferById(id: string | null | undefined): ReefTransfer | null {
    if (!id) return null
    return transfers.value.find((item) => item.id === id) ?? null
  }

  async function createTransfer(input: {
    operator: string
    remark: string
    items: Array<{ siteId: string; toReefId: string }>
  }) {
    return createAndApplyTransfer(input)
  }

  async function revert(id: string): Promise<void> {
    await revertTransfer(id)
  }

  async function resolveBelt(
    beltId: string,
    resolution: { reefId: string; siteNo: string; reason: string }
  ): Promise<void> {
    await resolveSuspendedBelt(beltId, resolution)
  }

  async function retryField(transferId: string, siteId: string): Promise<void> {
    await retryFieldItem(transferId, siteId)
  }

  return {
    transfers,
    suspendedBeltIds,
    suspendedCount,
    hasActiveTransfer,
    ready,
    start,
    transferById,
    createTransfer,
    revert,
    resolveBelt,
    retryField
  }
})
