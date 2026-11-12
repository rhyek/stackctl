// A CI run defaults stackctl's mode to `test`, and Ink (through `is-in-ci`) stops being
// interactive, so the specs, and every CLI they start, run as they would outside CI: the
// variables are deleted rather than emptied, since `is-in-ci` counts an empty one as CI. A spec
// about CI sets `CI` itself.
delete process.env.CI;
delete process.env.CONTINUOUS_INTEGRATION;

// Nor as a coding agent's, when a coding agent runs the suite: an agent's commands must name the
// mode, which the specs leave to the default. A spec about agents sets the variable itself.
process.env.STACKCTL_STARTED_BY_AGENT = '0';
