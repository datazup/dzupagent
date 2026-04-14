#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_BRANCH="main"
DRY_RUN=0
readonly REQUIRED_CHECKS=(
  "orchestration-race"
  "orchestration-cancel"
  "orchestration-contracts"
)
readonly WORKFLOW_FILES=(
  "orchestration-race.yml"
  "orchestration-cancel.yml"
  "orchestration-contracts.yml"
)

usage() {
  cat <<'USAGE'
Usage: configure-orchestration-protection-and-dispatch.sh [options]

Configures required status checks on main, optionally enforces admins,
dispatches the orchestration workflows on main, and prints the latest run summaries.

Required environment variables:
  OWNER             GitHub repository owner/org
  REPO              GitHub repository name

Optional environment variables:
  ENFORCE_ADMINS    Set to 1/true/yes/on to enforce branch protection for admins

Options:
  --dry-run         Print planned gh commands without applying protection or dispatching workflows
  --enforce-admins  Enforce branch protection for admins
  --help, -h        Show this help text
USAGE
}

log() {
  printf '[%s] %s\n' "$1" "$2"
}

fail() {
  log "error" "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

require_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "Required environment variable is not set: $name"
  fi
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

print_command() {
  local arg
  printf '+'
  for arg in "$@"; do
    printf ' %q' "$arg"
  done
  printf '\n'
}

run_write_command() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    print_command "$@"
    return 0
  fi

  "$@" >/dev/null
}

check_gh_auth() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    log info "Dry-run enabled; skipping GitHub CLI authentication check"
    return
  fi

  log info "Checking GitHub CLI authentication"
  gh auth status >/dev/null 2>&1 || fail "gh is not authenticated. Run 'gh auth login' and retry."
}

branch_protection_exists() {
  gh api "repos/$OWNER/$REPO/branches/$DEFAULT_BRANCH/protection" >/dev/null 2>&1
}

apply_required_status_checks() {
  log info "Applying required status checks on $DEFAULT_BRANCH for $OWNER/$REPO"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log info "Dry-run: branch protection existence is not probed; showing both possible write commands"
    print_command \
      gh api \
      -X PATCH \
      "repos/$OWNER/$REPO/branches/$DEFAULT_BRANCH/protection/required_status_checks" \
      -f strict=true \
      -f "checks[][context]=${REQUIRED_CHECKS[0]}" \
      -f "checks[][context]=${REQUIRED_CHECKS[1]}" \
      -f "checks[][context]=${REQUIRED_CHECKS[2]}"
    print_command \
      gh api \
      -X PUT \
      "repos/$OWNER/$REPO/branches/$DEFAULT_BRANCH/protection" \
      -H "Accept: application/vnd.github+json" \
      -f required_status_checks.strict=true \
      -f "required_status_checks.checks[][context]=${REQUIRED_CHECKS[0]}" \
      -f "required_status_checks.checks[][context]=${REQUIRED_CHECKS[1]}" \
      -f "required_status_checks.checks[][context]=${REQUIRED_CHECKS[2]}" \
      -F enforce_admins=false \
      -F required_pull_request_reviews=null \
      -F restrictions=null \
      -F required_linear_history=false \
      -F allow_force_pushes=false \
      -F allow_deletions=false \
      -F block_creations=false \
      -F required_conversation_resolution=false \
      -F lock_branch=false \
      -F allow_fork_syncing=false
    return
  fi

  if branch_protection_exists; then
    run_write_command \
      gh api \
      -X PATCH \
      "repos/$OWNER/$REPO/branches/$DEFAULT_BRANCH/protection/required_status_checks" \
      -f strict=true \
      -f "checks[][context]=${REQUIRED_CHECKS[0]}" \
      -f "checks[][context]=${REQUIRED_CHECKS[1]}" \
      -f "checks[][context]=${REQUIRED_CHECKS[2]}"
    log info "Updated required status checks on existing branch protection"
    return
  fi

  run_write_command \
    gh api \
    -X PUT \
    "repos/$OWNER/$REPO/branches/$DEFAULT_BRANCH/protection" \
    -H "Accept: application/vnd.github+json" \
    -f required_status_checks.strict=true \
    -f "required_status_checks.checks[][context]=${REQUIRED_CHECKS[0]}" \
    -f "required_status_checks.checks[][context]=${REQUIRED_CHECKS[1]}" \
    -f "required_status_checks.checks[][context]=${REQUIRED_CHECKS[2]}" \
    -F enforce_admins=false \
    -F required_pull_request_reviews=null \
    -F restrictions=null \
    -F required_linear_history=false \
    -F allow_force_pushes=false \
    -F allow_deletions=false \
    -F block_creations=false \
    -F required_conversation_resolution=false \
    -F lock_branch=false \
    -F allow_fork_syncing=false
  log info "Created branch protection with required status checks"
}

enforce_admins_if_requested() {
  if ! is_truthy "${ENFORCE_ADMINS:-0}"; then
    log info "Admin enforcement not requested; leaving current admin enforcement unchanged"
    return
  fi

  log info "Enforcing branch protection for admins"
  run_write_command \
    gh api \
    -X POST \
    "repos/$OWNER/$REPO/branches/$DEFAULT_BRANCH/protection/enforce_admins"
}

dispatch_workflows() {
  local workflow
  for workflow in "${WORKFLOW_FILES[@]}"; do
    log info "Dispatching $workflow on $DEFAULT_BRANCH"
    run_write_command \
      gh workflow run "$workflow" --repo "$OWNER/$REPO" --ref "$DEFAULT_BRANCH"
  done
}

print_latest_run_summary() {
  local workflow="$1"
  local summary

  summary="$(gh run list \
    --repo "$OWNER/$REPO" \
    --workflow "$workflow" \
    --branch "$DEFAULT_BRANCH" \
    --limit 1 \
    --json databaseId,displayTitle,event,headBranch,startedAt,status,conclusion,url \
    --jq 'if length == 0 then "no runs found" else .[0] | "run=#\(.databaseId) title=\(.displayTitle) branch=\(.headBranch) event=\(.event) status=\(.status) conclusion=\(.conclusion // \"pending\") started=\(.startedAt) url=\(.url)" end') 2>/dev/null)"

  if [[ -z "$summary" ]]; then
    summary="no runs found"
  fi

  printf '  - %s: %s\n' "$workflow" "$summary"
}

print_latest_run_summaries() {
  local workflow

  if [[ "$DRY_RUN" -eq 1 ]]; then
    log info "Dry-run enabled; skipping latest workflow run summaries"
    return
  fi

  log info "Latest workflow runs on $DEFAULT_BRANCH"
  for workflow in "${WORKFLOW_FILES[@]}"; do
    print_latest_run_summary "$workflow"
  done
}

main() {
  require_command gh
  require_env OWNER
  require_env REPO

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --enforce-admins)
        ENFORCE_ADMINS=1
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        usage >&2
        fail "Unknown argument: $1"
        ;;
    esac
  done

  check_gh_auth
  apply_required_status_checks
  enforce_admins_if_requested
  dispatch_workflows
  print_latest_run_summaries
}

main "$@"
