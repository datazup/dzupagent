/**
 * HumanContact types -- shared type definitions for the generalized
 * human-in-the-loop contact tool.
 *
 * The HumanContactTool uses these types to structure requests and responses
 * across all contact modes: approval, clarification, input_request, escalation.
 *
 * Channel resolution order:
 * 1. explicit channel in tool call
 * 2. user profile preferred channel
 * 3. agent config default channel
 * 4. 'in-app' fallback (always available)
 */

// --- Contact Types --------------------------------------------------------------

/**
 * Well-known contact modes. Extensible via string union so plugins can
 * add custom types without modifying this file.
 */
export type ContactType =
  | 'approval'       // binary approve/reject decision
  | 'clarification'  // agent asks a question, human answers free-form
  | 'input_request'  // agent needs structured input data from human
  | 'escalation'     // agent hands off to a human for resolution
  | (string & {})    // extensible: plugin-defined contact types

/** Available channels for delivering human contact requests */
export type ContactChannel =
  | 'in-app'    // in-application notification (always available)
  | 'slack'     // Slack message/DM
  | 'email'     // email notification
  | 'webhook'   // arbitrary webhook delivery
  | (string & {}) // extensible

// --- Request Types --------------------------------------------------------------

/** Base fields for all human contact requests */
interface HumanContactRequestBase {
  /** Unique identifier for this contact request -- appears in all events/responses */
  contactId: string
  /** The run that generated this request */
  runId: string
  /** Contact mode */
  type: ContactType
  /** Preferred channel (step 1 in chain-of-responsibility resolution) */
  channel?: ContactChannel
  /** ISO 8601 timeout deadline -- auto-resumes with fallback after this */
  timeoutAt?: string
  /** Default value to use on timeout */
  timeoutFallback?: unknown
  /** Correlation metadata for tracing */
  metadata?: Record<string, unknown>
}

export interface ApprovalRequest extends HumanContactRequestBase {
  type: 'approval'
  data: {
    question: string
    context?: string
    /** Options shown to the approver */
    options?: Array<{ label: string; value: string }>
  }
}

export interface ClarificationRequest extends HumanContactRequestBase {
  type: 'clarification'
  data: {
    question: string
    context?: string
    /** Suggested answers shown to the human (optional) */
    suggestions?: string[]
  }
}

export interface InputRequest extends HumanContactRequestBase {
  type: 'input_request'
  data: {
    prompt: string
    /** JSON Schema describing the expected input shape */
    schema?: Record<string, unknown>
    context?: string
  }
}

export interface EscalationRequest extends HumanContactRequestBase {
  type: 'escalation'
  data: {
    summary: string
    /** What the agent tried and why it's escalating */
    reason: string
    /** Suggested resolution paths */
    suggestions?: string[]
  }
}

/** Generic extensible request for plugin-defined contact types */
export interface GenericContactRequest extends HumanContactRequestBase {
  type: string
  data: Record<string, unknown>
}

/** Union of all request types */
export type HumanContactRequest =
  | ApprovalRequest
  | ClarificationRequest
  | InputRequest
  | EscalationRequest
  | GenericContactRequest

// --- Response Types --------------------------------------------------------------

/** Base fields for all human contact responses */
interface HumanContactResponseBase {
  contactId: string
  runId: string
  /** ISO 8601 timestamp of the response */
  respondedAt: string
  /** Who responded (user ID, email, etc.) */
  respondedBy?: string
}

export interface ApprovalResponse extends HumanContactResponseBase {
  type: 'approval'
  approved: boolean
  comment?: string
}

export interface ClarificationResponse extends HumanContactResponseBase {
  type: 'clarification'
  answer: string
}

export interface InputResponse extends HumanContactResponseBase {
  type: 'input_request'
  data: Record<string, unknown>
}

export interface EscalationResponse extends HumanContactResponseBase {
  type: 'escalation'
  resolution: string
  resolvedBy: string
}

export interface TimeoutResponse extends HumanContactResponseBase {
  type: 'timeout'
  fallback: unknown
}

export interface LateResponse extends HumanContactResponseBase {
  type: 'late_response'
  originalType: ContactType
  data: unknown
}

export interface GenericContactResponse extends HumanContactResponseBase {
  type: string
  payload: unknown
}

/** Union of all response types */
export type HumanContactResponse =
  | ApprovalResponse
  | ClarificationResponse
  | InputResponse
  | EscalationResponse
  | TimeoutResponse
  | LateResponse
  | GenericContactResponse

// --- Pending Contact --------------------------------------------------------------

/**
 * A pending human contact -- stored until the human responds or it times out.
 */
export interface PendingHumanContact {
  request: HumanContactRequest
  /** How to resume the run once the human responds */
  resumeToken: string
  /** When this pending contact expires */
  expiresAt?: string
  /** Channel the request was delivered to */
  deliveredTo?: ContactChannel
  /** Delivery status */
  deliveryStatus: 'pending' | 'delivered' | 'failed'
}
