# Contract: Effective Capability Manifest

## Purpose

Make setup, runtime, and doctor agree on one effective non-secret configuration.

## Inputs

- one versioned resource profile
- one summary provider choice
- one embedding provider state:
  - `enabled` with provider/model/endpoint/credential metadata, or
  - `disabled` with a machine-readable reason
- explicit credential references
- detected platform and Agent capabilities
- supported InjectionPack destination-policy map keyed by Agent/model destination class, with
  execution location and egress policy
- compatible legacy settings, when migration is requested

## Output

The compiler returns either:

- a validated immutable manifest ready for atomic activation, or
- structured validation failures that leave the prior manifest active.

The manifest includes its version/identity, profile limits, effective model and endpoint host,
credential source, enabled and disabled capabilities, fallback policy, a versioned destination map
binding each target Agent to local/remote execution and egress policy, and a non-secret fingerprint.

## Invariants

- Summary and embedding choices are independent.
- Disabled is an explicit provider state, not an empty model, missing endpoint, or other sentinel.
- Provider egress policy distinguishes on-device consumers from remote/off-host destinations;
  private and local-only data are eligible only for the former and secrets are eligible for neither.
- Technical Alpha provider HTTP redirects are rejected before any payload is resent, and doctor
  reports the bounded redirect reason. The rejected job resumes only after activation of a changed,
  validated configuration for that provider; the prior `Location` is never followed or replayed.
  A later redirect allowlist requires a new explicit contract.
- Every remote/off-host ProviderChoice requires `endpointScheme=https` and certificate-chain and
  hostname validation with no insecure bypass, whether or not it uses credentials. Initial HTTP
  connections and HTTPS-to-HTTP downgrade attempts are rejected before credentials or payload bytes
  are sent and are reported by setup/doctor.
- Each InjectionPack request supplies its concrete target Agent/model destination and resolves it
  against the active manifest's policy map. Unknown destinations are remote/ineligible for private
  and local-only data; either disposition requires a matching explicit on-device policy.
- Secret values never appear in the manifest, logs, doctor output, or fingerprint.
- Runtime consumers do not read legacy configuration or provider environment independently.
- A scenario that changes provider execution first activates a separately fingerprinted validated
  manifest bound to the prior active-manifest fingerprint; scenario-local provider overrides are
  never accepted.
- Doctor reports the active manifest, not a separately reconstructed approximation.
- Any ignored, translated, overridden, or conflicting legacy setting is reported.
- Model or index changes that require rebuilding never remove lexical retrieval during transition.
