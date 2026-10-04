<script setup lang="ts">
/**
 * <AttribTag> 外业归属账状态标记：正常计入 / 挂起等人定。
 * 被样带布设页、覆盖度汇总页、界线划转页消费。
 */
import { computed } from 'vue'
import { Clock, Link } from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    status: 'active' | 'suspended' | string
    reason?: string
    size?: 'default' | 'small'
  }>(),
  { reason: '', size: 'default' }
)

const suspended = computed(() => props.status === 'suspended')
const tip = computed(() =>
  suspended
    ? `外业归属挂起：${props.reason || '两账按站位编号对不上，等待人工裁定'}`
    : '外业归属账与保护站账一致，正常计入礁区结论'
)
</script>

<template>
  <el-tooltip :content="tip" placement="top">
    <span class="attrib-tag" :class="[`is-${size}`, suspended ? 'is-suspended' : 'is-active']">
      <el-icon class="attrib-tag__icon"><component :is="suspended ? Clock : Link" /></el-icon>
      <span>{{ suspended ? '挂起等人定' : '归属已对齐' }}</span>
    </span>
  </el-tooltip>
</template>

<style scoped>
.attrib-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.attrib-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.attrib-tag.is-suspended {
  color: #9a6700;
  background: #fdf3e3;
  border-color: #d68910;
}

.attrib-tag.is-active {
  color: #0b5d5a;
  background: #eaf6ee;
  border-color: #1e8449;
}

.attrib-tag__icon {
  font-size: 13px;
}
</style>
