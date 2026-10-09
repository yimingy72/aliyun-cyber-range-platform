package fastwaitchecks

import (
	"errors"
	"testing"
	"time"

	"github.com/hashicorp/terraform-plugin-sdk/helper/resource"
)

func createWaiter(refresh resource.StateRefreshFunc) *resource.StateChangeConf {
	return BuildStateConf([]string{"Pending", "Starting", "Stopped"}, []string{"Running"}, 10*time.Minute, 2*time.Second, refresh)
}

func TestCreateInitialDelayAndSuccessContract(t *testing.T) {
	start := time.Now()
	conf := createWaiter(func() (interface{}, string, error) {
		if time.Since(start) < 2*time.Second {
			t.Error("First status query ran before initial delay")
		}
		return "instance", "Running", nil
	})
	if conf.Delay != 2*time.Second || conf.MinTimeout != 3*time.Second || conf.Timeout != 10*time.Minute {
		t.Fatal("Production waiter timings changed")
	}
	result, err := conf.WaitForState()
	if err != nil || result != "instance" {
		t.Fatalf("Running instance not confirmed: %v %v", result, err)
	}
}

func TestEventuallyConsistentCreateDoesNotCompleteOnNotFound(t *testing.T) {
	calls := 0
	conf := createWaiter(func() (interface{}, string, error) {
		calls++
		switch calls {
		case 1, 2:
			return nil, "", nil
		case 3:
			return "instance", "Pending", nil
		case 4:
			return "instance", "Starting", nil
		default:
			return "instance", "Running", nil
		}
	})
	// Scale the clock only; exercise the provider's actual SDK target/NotFound semantics.
	conf.Delay, conf.MinTimeout, conf.PollInterval = 0, time.Millisecond, time.Millisecond
	result, err := conf.WaitForState()
	if err != nil || result != "instance" || calls != 5 {
		t.Fatalf("Premature/failed readiness: calls=%d result=%v err=%v", calls, result, err)
	}
}

func TestMissingInstanceNeverCountsAsCreated(t *testing.T) {
	calls := 0
	conf := createWaiter(func() (interface{}, string, error) { calls++; return nil, "", nil })
	conf.Delay, conf.MinTimeout, conf.PollInterval = 0, time.Millisecond, time.Millisecond
	_, err := conf.WaitForState()
	if err == nil || calls < 2 {
		t.Fatalf("Missing instance incorrectly succeeded: calls=%d err=%v", calls, err)
	}
}

func TestQueryErrorAndUnexpectedStateRemainFailures(t *testing.T) {
	for _, tc := range []struct {
		name, status string
		err          error
	}{
		{"query error", "", errors.New("Throttling.User")},
		{"unexpected state", "Stopping", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conf := createWaiter(func() (interface{}, string, error) { return "instance", tc.status, tc.err })
			conf.Delay = 0
			if _, err := conf.WaitForState(); err == nil {
				t.Fatal("Failure must never become Running")
			}
		})
	}
}
