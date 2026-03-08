package control

import (
	"math"
	"testing"
)

func assertProbeScoreEqual(t *testing.T, got float64, want float64) {
	t.Helper()
	if math.Abs(got-want) > 0.0001 {
		t.Fatalf("unexpected probe score: got=%.4f want=%.4f", got, want)
	}
}

func TestComputeNodeProbeScoreUsesLatencyAndRealConnectOnly(t *testing.T) {
	assertProbeScoreEqual(t, computeNodeProbeScore(Node{}), 0)

	assertProbeScoreEqual(
		t,
		computeNodeProbeScore(Node{
			LatencyMS:          40,
			ProbeRealConnectMS: 120,
		}),
		100,
	)

	assertProbeScoreEqual(
		t,
		computeNodeProbeScore(Node{
			LatencyMS: 20,
		}),
		55,
	)

	assertProbeScoreEqual(
		t,
		computeNodeProbeScore(Node{
			ProbeRealConnectMS: 50,
		}),
		80,
	)

	assertProbeScoreEqual(
		t,
		computeNodeProbeScore(Node{
			LatencyMS:          340,
			ProbeRealConnectMS: 1125,
		}),
		50,
	)

	// Both metrics are available here. High latency must still participate in
	// weighted score, instead of being treated as "missing".
	assertProbeScoreEqual(
		t,
		computeNodeProbeScore(Node{
			LatencyMS:          1273,
			ProbeRealConnectMS: 620,
		}),
		51.3,
	)
	assertProbeScoreEqual(
		t,
		computeNodeProbeScore(Node{
			LatencyMS:          352,
			ProbeRealConnectMS: 353,
		}),
		77.9,
	)

	assertProbeScoreEqual(t, computeNodeProbeScore(Node{}), 0)
}
