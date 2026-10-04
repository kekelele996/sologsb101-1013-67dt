<script setup lang="ts">
/**
 * <TransferStatusTag> 划转单侧 / 整单状态徽标。
 * 被站位划转台账页（/transfers）消费。
 */
import { computed } from 'vue'
import type { SideStatus, TransferStage } from '@/types/ownership'
import { SIDE_STATUS_META, TRANSFER_STAGE_META } from '@/types/ownership'

const props = withDefaults(
  defineProps<{
    status: SideStatus | TransferStage
    kind?: 'side' | 'stage'
  }>(),
  { kind: 'side' }
)

const meta = computed(() =>
  props.kind === 'stage'
    ? TRANSFER_STAGE_META[props.status as TransferStage]
    : SIDE_STATUS_META[props.status as SideStatus]
)

const toneClass = computed(() => {
  switch (meta.value.tone) {
    case 'success':
      return 'is-success'
    case 'warning':
      return 'is-warning'
    case 'danger':
      return 'is-danger'
    case 'info':
      return 'is-info'
    default:
      return 'is-plain'
  }
})
</script>

<template>
  <el-tag size="small" :class="['transfer-status-tag', toneClass]" effect="light" disable-transitions>
    {{ meta.label }}
  </el-tag>
</template>

<style scoped>
.transfer-status-tag {
  border-radius: 999px;
}

.transfer-status-tag.is-success {
  color: #1e8449;
  background: #e9f7ef;
  border-color: #abebc6;
}

.transfer-status-tag.is-warning {
  color: #b9770e;
  background: #fef5e7;
  border-color: #f7dc8f;
}

.transfer-status-tag.is-danger {
  color: #c0392b;
  background: #fdedec;
  border-color: #f5b7b1;
}

.transfer-status-tag.is-info {
  color: #1f618d;
  background: #ebf5fb;
  border-color: #aed6f1;
}

.transfer-status-tag.is-plain {
  color: #7c9995;
  background: #f4f7f6;
  border-color: #d5e2df;
}
</style>
