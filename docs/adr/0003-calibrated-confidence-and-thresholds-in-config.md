# 0003 Policies compare calibrated probabilities with thresholds in config

Status: accepted

A model's self-reported confidence is not a probability. The service returns a calibrated estimate (isotonic,
smoothed, conservative outside its data), and the BPMN compares it with `config/automations.yaml`. A model or prompt
change needs a new calibration; without one the confidence is 0 and people decide. The blind held-out set showed why
this matters: on hand-written messages the simulated classifier was right half the time, and none of those leads was
routed without a person.
