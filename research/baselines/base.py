"""Baseline ABC + registry."""

from __future__ import annotations

from abc import ABC, abstractmethod

from benchmark.schema import BenchRecord, Prediction

_REGISTRY: dict[str, type["Baseline"]] = {}


def register_baseline(name: str):
    def deco(cls: type["Baseline"]):
        _REGISTRY[name] = cls
        cls.baseline_name = name
        return cls
    return deco


def get_baseline(name: str, **kwargs) -> "Baseline":
    return _REGISTRY[name](**kwargs)


def all_baselines() -> list[str]:
    return sorted(_REGISTRY.keys())


class Baseline(ABC):
    baseline_name: str = "unknown"

    @abstractmethod
    def predict(self, record: BenchRecord) -> Prediction:
        ...

    def warmup(self) -> None:
        """Optional: load models / open connections before the run loop."""

    def shutdown(self) -> None:
        """Optional: clean up resources."""
