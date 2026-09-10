"""Selective agent safety — detector competence under distribution shift.

The research question this package answers:

    Every agent-safety detector degrades under distribution shift, and
    none of them report that degradation. Can a guard know when it does
    not know?

Modules:
    loader      join predictions with benchmark labels (distribution, source)
    degradation drift-degradation curves per detector family
    complement  failure-complementarity matrix (justifies cascading at all)
    conformal   distribution-free risk control with abstention
"""
