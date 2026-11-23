// What `-s` names and `-t` tags select together: a list of service names.

/** A tag that no service (or infra service) has. */
export class UnknownTagError extends Error {}

/** Anything with a name and tags: a service, or an infra service. */
export interface Tagged {
  name: string;
  tags: readonly string[];
}

export interface TagSelection {
  /** `known`'s order, then any name `known` lacks, as given. No name twice. */
  names: string[];
  /** The names in `names` that no `-s` gave: matched by a tag alone. */
  fromTagOnly: ReadonlySet<string>;
}

/**
 * Turns `-s` names and `-t` tags into the names they select: every name given, plus every
 * `known` entry that has any of the tags. A name `known` lacks is kept, after the known ones,
 * for the command's own check to report. Throws {@link UnknownTagError} naming every tag that
 * no `known` entry has.
 */
export function selectByTags(
  known: readonly Tagged[],
  selection: { names: readonly string[]; tags: readonly string[] },
  kind: 'service' | 'infra service',
): TagSelection {
  const unknownTags = [...new Set(selection.tags)].filter(
    (tag) => !known.some((k) => k.tags.includes(tag)),
  );
  if (unknownTags.length > 0) {
    throw new UnknownTagError(
      `No ${kind} has the ${unknownTags.length === 1 ? 'tag' : 'tags'}: ${unknownTags.join(', ')}`,
    );
  }
  const given = new Set(selection.names);
  const knownNames = new Set(known.map((k) => k.name));
  const names: string[] = [];
  const fromTagOnly = new Set<string>();
  for (const k of known) {
    if (given.has(k.name)) {
      names.push(k.name);
    } else if (k.tags.some((tag) => selection.tags.includes(tag))) {
      names.push(k.name);
      fromTagOnly.add(k.name);
    }
  }
  for (const name of given) {
    if (!knownNames.has(name)) {
      names.push(name);
    }
  }
  return { names, fromTagOnly };
}
