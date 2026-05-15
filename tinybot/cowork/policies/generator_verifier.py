"""Generator-Verifier architecture policy."""

from tinybot.cowork.policies.base import ArchitectureRuntimePolicy


class GeneratorVerifierPolicy(ArchitectureRuntimePolicy):
    architecture = "generator_verifier"
    display_name = "Generator-Verifier"
    runtime_profile = "generator_verifier"
