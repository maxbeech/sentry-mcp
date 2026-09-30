import {
  ACTIVE_SKILLS,
  parseSkills,
  type Skill,
} from "@sentry/mcp-core/skills";

/**
 * Which skills a request may use, decided by the URL the caller connected to.
 *
 * The same rules as `mcp.sentry.dev`'s own direct `Sentry-Bearer` mode (see
 * `resolveDirectGrantedSkills` in packages/mcp-cloudflare), because a caller
 * who knows one should not have to learn another: no query means every active
 * skill, `?skills=a,b` REPLACES that set, `?disable-skills=x` removes from it.
 *
 * It exists so a connection can ask for LESS than this deployment offers. The
 * default grants triage and project management because the token behind a
 * request is what really decides whether a write lands, but a consumer that
 * only closes incidents has no use for `create_project` and should not be
 * handed it: `?skills=inspect,triage` states that in the address itself.
 *
 * An unknown or empty skill is refused, never dropped. A typo that silently
 * widened or emptied the grant is exactly the kind of mistake a permission
 * boundary must not absorb.
 */
export type SkillResolution =
  | { ok: true; grantedSkills: Set<Skill> }
  | { ok: false; message: string };

export function resolveGrantedSkills(params: URLSearchParams): SkillResolution {
  let granted: Set<Skill>;

  if (params.has("skills")) {
    const { valid, invalid } = parseSkills(params.get("skills"));
    if (invalid.length > 0) {
      return {
        ok: false,
        message: `skills provided invalid skills: ${invalid.join(", ")}`,
      };
    }
    if (valid.size === 0) {
      return {
        ok: false,
        message: "skills must include at least one valid skill",
      };
    }
    granted = valid;
  } else {
    granted = new Set(ACTIVE_SKILLS);
  }

  const disable = params.get("disable-skills");
  if (disable) {
    const { valid, invalid } = parseSkills(disable);
    if (invalid.length > 0) {
      return {
        ok: false,
        message: `disable-skills provided invalid skills: ${invalid.join(", ")}`,
      };
    }
    for (const skill of valid) granted.delete(skill);
    if (granted.size === 0) {
      return {
        ok: false,
        message:
          "disable-skills removed all available skills; at least one skill must remain enabled",
      };
    }
  }

  return { ok: true, grantedSkills: granted };
}
