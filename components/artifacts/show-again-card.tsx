"use client";

import type { ArtifactPartProps, LessonMaterial } from "@/src/core";
import { DemoOutputCard } from "@/components/artifacts/demo-card";
import { VisualOutputCard } from "@/components/artifacts/visual-card";

/** A separate transcript card, never part of a question or its answer dock. */
export function ShowAgainCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available") return null;
	const output = part.output as { ok?: boolean; material?: LessonMaterial } | undefined;
	if (!output?.ok || !output.material) return null;
	const material = output.material;
	return <div className="min-w-0 max-w-full" data-testid="show-again-card">
		{material.kind === "demo"
			? <DemoOutputCard output={material.result} initialInverted={material.inverted} />
			: <VisualOutputCard output={material.result} initialInverted={material.inverted} />}
	</div>;
}
