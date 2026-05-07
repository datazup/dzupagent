import type { ApprovalNode, FlowNode } from '../types.js'
import {
  type ParseContext,
  describeJsType,
  joinPointer,
  parseCommonNodeFields,
} from './shared.js'

export function parseApproval(
  obj: Record<string, unknown>,
  pointer: string,
  ctx: ParseContext,
): ApprovalNode | null {
  const questionRaw = obj.question
  const onApproveRaw = obj.onApprove
  let failed = false

  if (typeof questionRaw !== 'string') {
    ctx.errors.push({
      code: 'WRONG_FIELD_TYPE',
      message: `approval.question must be a string, received ${describeJsType(questionRaw)}`,
      pointer: joinPointer(pointer, 'question'),
    })
    failed = true
  }
  if (!Array.isArray(onApproveRaw)) {
    ctx.errors.push({
      code: onApproveRaw === undefined ? 'WRONG_FIELD_TYPE' : 'EXPECTED_ARRAY',
      message: `approval.onApprove must be an array, received ${describeJsType(onApproveRaw)}`,
      pointer: joinPointer(pointer, 'onApprove'),
    })
    failed = true
  }

  let options: string[] | undefined
  if ('options' in obj) {
    const optionsRaw = obj.options
    if (Array.isArray(optionsRaw) && optionsRaw.every((v) => typeof v === 'string')) {
      options = optionsRaw as string[]
    } else if (Array.isArray(optionsRaw)) {
      ctx.errors.push({
        code: 'WRONG_FIELD_TYPE',
        message: `approval.options must be an array of strings`,
        pointer: joinPointer(pointer, 'options'),
      })
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `approval.options must be an array when present, received ${describeJsType(optionsRaw)}`,
        pointer: joinPointer(pointer, 'options'),
      })
    }
  }

  if (failed) {
    if (Array.isArray(onApproveRaw)) ctx.parseNodeArray(onApproveRaw, joinPointer(pointer, 'onApprove'), ctx)
    if ('onReject' in obj && Array.isArray(obj.onReject)) {
      ctx.parseNodeArray(obj.onReject, joinPointer(pointer, 'onReject'), ctx)
    }
    return null
  }

  const onApprove = ctx.parseNodeArray(onApproveRaw as unknown[], joinPointer(pointer, 'onApprove'), ctx)

  let onReject: FlowNode[] | undefined
  if ('onReject' in obj) {
    const onRejectRaw = obj.onReject
    if (Array.isArray(onRejectRaw)) {
      onReject = ctx.parseNodeArray(onRejectRaw, joinPointer(pointer, 'onReject'), ctx)
    } else {
      ctx.errors.push({
        code: 'EXPECTED_ARRAY',
        message: `approval.onReject must be an array when present, received ${describeJsType(onRejectRaw)}`,
        pointer: joinPointer(pointer, 'onReject'),
      })
    }
  }

  const node: ApprovalNode = {
    type: 'approval',
    ...parseCommonNodeFields(obj, pointer, ctx),
    question: questionRaw as string,
    onApprove,
  }
  if (options !== undefined) node.options = options
  if (onReject !== undefined) node.onReject = onReject
  return node
}
