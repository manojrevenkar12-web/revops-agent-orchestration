# 0005 A simulated model behind the same contract as Claude

Status: accepted

The build has no model API key. The simulated provider receives the same Messages API call (system prompt, input in
<input> tags, tools, forced tool) and returns the same content blocks, so prompt construction, tool schemas,
validation, the repair loop, the agent loop and the checks run in every test. It can be made to misbehave (invalid
output, invented numbers, uncited claims, leaks, outages) for the fault runs. Results with the simulated provider say
nothing about Claude's accuracy; they say the process holds when the model is wrong.
