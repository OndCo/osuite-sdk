const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

function colorize(value, color, enabled) {
  return enabled ? `${color}${value}${RESET}` : value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getActionId(action = {}) {
  return action.action_id || action.id || action.actionId || 'unknown-action';
}

function getScore(action = {}) {
  const summary = action.decision_summary || action.scorecard || action.risk_presentation || {};
  return summary.policyScore ?? summary.rawScore ?? action.risk_score ?? action.agent_risk_score ?? null;
}

function getGrade(score) {
  if (score == null || Number.isNaN(Number(score))) return 'Unscored';
  const numeric = Number(score);
  if (numeric >= 85) return 'Critical';
  if (numeric >= 70) return 'High';
  if (numeric >= 45) return 'Moderate';
  return 'Low';
}

function getGradeColor(grade) {
  if (grade === 'Critical' || grade === 'High') return RED;
  if (grade === 'Moderate') return YELLOW;
  return GREEN;
}

function line(label, value) {
  if (value == null || value === '') return null;
  return `${label.padEnd(21)} ${value}`;
}

function normalizeDecisionSummary(action = {}) {
  const summary = action.decision_summary || action.scorecard || action.risk_presentation || {};
  const understood = summary.understoodAction || summary.understood_action || {};
  const evidence = summary.evidenceConfidence || summary.evidence_confidence || {};
  const control = summary.controlSummary || summary.control_summary || {};
  const dimensions = summary.dimensions || summary.scoreDimensions || summary.score_dimensions || [];
  const scoreBreakdown = summary.scoreBreakdown || summary.score_breakdown || {};

  return {
    understood,
    evidence,
    control,
    scoreModel: summary.scoreModel || summary.score_model || scoreBreakdown.model_version,
    scoreBreakdown,
    dimensions: asArray(dimensions),
    missingEvidence: asArray(summary.missingEvidence || summary.missing_evidence),
  };
}

export function buildReviewSurface(action = {}, options = {}) {
  const color = options.color ?? !process.env.NO_COLOR;
  const score = getScore(action);
  const grade = action.decision_grade || action.grade || getGrade(score);
  const gradeColor = getGradeColor(grade);
  const summary = normalizeDecisionSummary(action);
  const actionId = getActionId(action);
  const title = `OSuite Decision Review`;
  const scoreText = score == null ? 'not scored' : `${Math.round(Number(score))}/100`;
  const understoodSummary = summary.understood.summary
    || summary.understood.label
    || action.declared_goal
    || action.action_type
    || 'No action summary was provided.';
  const evidenceLabel = summary.evidence.label
    || (summary.evidence.score != null ? `${summary.evidence.score}/100` : null)
    || 'Evidence confidence not provided';
  const controlLabel = summary.control.label
    || summary.control.summary
    || action.effective_decision
    || action.status
    || 'No control posture provided';

  const rows = [
    line('Action ID', actionId),
    line('Agent', action.agent_name || action.agent_id),
    line('Action type', action.action_type),
    line('Decision', action.effective_decision || action.decision || action.status),
    line('Score model', summary.scoreModel),
    line('Score', `${scoreText} (${colorize(grade, gradeColor, color)})`),
    line('OSuite understood', understoodSummary),
    line('Evidence confidence', evidenceLabel),
    line('Control posture', controlLabel),
  ].filter(Boolean);

  const dimensionLines = summary.dimensions.length
    ? [
        '',
        colorize('Score dimensions', BOLD, color),
        ...summary.dimensions.map((dimension) => {
          const label = dimension.label || dimension.id || 'dimension';
          const value = dimension.score ?? dimension.value ?? '-';
          const reason = dimension.summary || dimension.reason || '';
          return `  ${label.padEnd(18)} ${String(value).padStart(3)}${reason ? `  ${colorize(reason, DIM, color)}` : ''}`;
        }),
      ]
    : [];

  const scoreComponents = asArray(summary.scoreBreakdown.components);
  const breakdownLines = scoreComponents.length
    ? [
        '',
        colorize('Score breakdown', BOLD, color),
        ...scoreComponents.map((component) => {
          const label = component.label || component.id || 'component';
          const value = component.value ?? component.score ?? component.contribution ?? '-';
          const sign = typeof value === 'number' && value > 0 && component.direction !== 'base' ? `+${value}` : String(value);
          const reason = component.detail || component.reason || component.summary || '';
          return `  ${label.padEnd(18)} ${String(sign).padStart(4)}${reason ? `  ${colorize(reason, DIM, color)}` : ''}`;
        }),
      ]
    : [];

  const missingEvidenceLines = summary.missingEvidence.length
    ? [
        '',
        colorize('Missing evidence', BOLD, color),
        ...summary.missingEvidence.map((item) => `  - ${item.label || item.id || item}`),
      ]
    : [];

  const baseUrl = options.baseUrl ? String(options.baseUrl).replace(/\/$/, '') : null;
  const replayUrl = baseUrl ? `${baseUrl}/replay/${actionId}` : null;
  // A request still waiting is decided by a person in Studio, so point there.
  const reviewUrl = baseUrl && action.status === 'pending_approval'
    ? `${baseUrl}/approvals?action=${encodeURIComponent(actionId)}`
    : null;
  const footer = [
    ...(reviewUrl ? ['', `${colorize('Review', BOLD, color)} ${reviewUrl}`] : []),
    ...(replayUrl ? [reviewUrl ? null : '', `${colorize('Replay', BOLD, color)} ${replayUrl}`].filter((line) => line !== null) : []),
  ];

  return [
    colorize(title, `${BOLD}${CYAN}`, color),
    colorize('Route. Review. Prove.', DIM, color),
    '',
    ...rows,
    ...breakdownLines,
    ...dimensionLines,
    ...missingEvidenceLines,
    ...footer,
  ].join('\n');
}

export default buildReviewSurface;
