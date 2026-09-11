#include <node_api.h>

#include <mach/mach_time.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#include <sys/utsname.h>

/*
 * This addon deliberately calls only public Mach, BSD, and Node-API functions.
 * It never addresses the commpage itself.
 *
 * macOS 26.5 / Darwin 25.5.0 implementation evidence:
 * - mach_approximate_time reads a monotonic cached absolute timestamp.
 * - mach_continuous_approximate_time reads the cumulative-sleep base then that
 *   cached timestamp and returns their sum.
 * - the XNU wake path publishes the cumulative-sleep base before it notifies
 *   calendar observers.
 *
 * Sources (not a future-Darwin API guarantee):
 * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/mach_approximate_time.c#L28-L37
 * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/libsyscall/wrappers/mach_continuous_time.c#L132-L140
 * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/osfmk/kern/clock.c#L1185-L1218
 * https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/iokit/Kernel/IOPMrootDomain.cpp#L3106-L3113
 *
 * A stable c1,a1,c2,a2 sample requires both continuous and approximate values
 * to remain unchanged. Cached approximate updates make it fail closed. With
 * monotonically increasing cache and sleep-base values, equality rejects a
 * sleep that crosses c2. The sample linearizes at c2; transit after c2 is
 * handled by the caller's synchronous authorization boundary.
 */

enum { kStableRetries = 16, kCanarySamples = 32 };

typedef struct {
  bool qualified;
  bool canary_ready;
  char release[sizeof(((struct utsname *)0)->release)];
  char machine[sizeof(((struct utsname *)0)->machine)];
  char os_build[64];
} clock_state;

static clock_state state;

static bool
set_named(napi_env env, napi_value object, const char *name, napi_value value)
{
  return napi_set_named_property(env, object, name, value) == napi_ok;
}

static bool
set_string(napi_env env, napi_value object, const char *name, const char *value)
{
  napi_value output;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &output) == napi_ok &&
      set_named(env, object, name, output);
}

static bool
set_boolean(napi_env env, napi_value object, const char *name, bool value)
{
  napi_value output;
  return napi_get_boolean(env, value, &output) == napi_ok && set_named(env, object, name, output);
}

static bool
set_number(napi_env env, napi_value object, const char *name, uint64_t value)
{
  if (value > UINT64_C(9007199254740991)) return false;
  napi_value output;
  return napi_create_double(env, (double)value, &output) == napi_ok && set_named(env, object, name, output);
}

static bool
set_bigint(napi_env env, napi_value object, const char *name, uint64_t value)
{
  napi_value output;
  return napi_create_bigint_uint64(env, value, &output) == napi_ok && set_named(env, object, name, output);
}

static bool
read_stable_epoch(uint64_t *epoch)
{
  for (unsigned retry = 0; retry < kStableRetries; ++retry) {
    const uint64_t c1 = mach_continuous_approximate_time();
    const uint64_t a1 = mach_approximate_time();
    const uint64_t c2 = mach_continuous_approximate_time();
    const uint64_t a2 = mach_approximate_time();
    if (c1 == c2 && a1 == a2 && c2 >= a2) {
      *epoch = c2 - a2;
      return true;
    }
  }
  return false;
}

static bool
ticks_to_milliseconds(uint64_t ticks, uint64_t *milliseconds)
{
  mach_timebase_info_data_t timebase;
  if (mach_timebase_info(&timebase) != KERN_SUCCESS || timebase.denom == 0) return false;
  const __uint128_t nanoseconds = ((__uint128_t)ticks * timebase.numer) / timebase.denom;
  const __uint128_t result = nanoseconds / UINT64_C(1000000);
  if (result > UINT64_C(9007199254740991)) return false;
  *milliseconds = (uint64_t)result;
  return true;
}

static bool
wall_milliseconds(uint64_t *milliseconds)
{
  struct timespec now;
  if (clock_gettime(CLOCK_REALTIME, &now) != 0 || now.tv_sec < 0 || now.tv_nsec < 0) return false;
  const __uint128_t result = ((__uint128_t)(uint64_t)now.tv_sec * UINT64_C(1000)) +
      ((uint64_t)now.tv_nsec / UINT64_C(1000000));
  if (result > UINT64_C(9007199254740991)) return false;
  *milliseconds = (uint64_t)result;
  return true;
}

static bool
read_os_build(char output[sizeof(state.os_build)])
{
  size_t length = sizeof(state.os_build);
  if (sysctlbyname("kern.osversion", output, &length, NULL, 0) != 0 || length == 0 || length > sizeof(state.os_build)) return false;
  output[sizeof(state.os_build) - 1] = '\0';
  return true;
}

static bool
run_canary(void)
{
  uint64_t baseline = 0;
  for (unsigned index = 0; index < kCanarySamples; ++index) {
    uint64_t epoch;
    if (!read_stable_epoch(&epoch)) return false;
    if (index == 0) baseline = epoch;
    else if (epoch != baseline) return false;
  }
  return true;
}

static void
initialize_state(void)
{
  memset(&state, 0, sizeof(state));
  struct utsname system;
  if (uname(&system) != 0 || !read_os_build(state.os_build)) return;
  (void)snprintf(state.release, sizeof(state.release), "%s", system.release);
  (void)snprintf(state.machine, sizeof(state.machine), "%s", system.machine);

  /* arm64 has physical runtime evidence. x86_64 is compiled/disassembled but
   * deliberately remains closed until physical qualification is recorded. */
  state.qualified = strcmp(system.sysname, "Darwin") == 0 &&
      strcmp(state.release, "25.5.0") == 0 && strcmp(state.os_build, "25F71") == 0 &&
      strcmp(state.machine, "arm64") == 0;
  state.canary_ready = state.qualified && run_canary();
}

static napi_value
metadata(napi_env env, napi_callback_info info)
{
  (void)info;
  napi_value output;
  if (napi_create_object(env, &output) != napi_ok ||
      !set_string(env, output, "platform", "darwin") ||
      !set_string(env, output, "release", state.release) ||
      !set_string(env, output, "osBuild", state.os_build) ||
      !set_string(env, output, "arch", state.machine) ||
      !set_boolean(env, output, "qualified", state.qualified) ||
      !set_boolean(env, output, "canaryReady", state.canary_ready)) return NULL;
  return output;
}

static napi_value
snapshot(napi_env env, napi_callback_info info)
{
  (void)info;
  if (!state.canary_ready) {
    napi_throw_error(env, "CLOCK_UNCERTAIN", "Native clock runtime is not qualified");
    return NULL;
  }

  uint64_t before, after, monotonic, wall;
  if (!read_stable_epoch(&before) || !ticks_to_milliseconds(mach_continuous_time(), &monotonic) ||
      !wall_milliseconds(&wall) || !read_stable_epoch(&after) || before != after) {
    napi_throw_error(env, "CLOCK_UNCERTAIN", "Native clock sample is unstable");
    return NULL;
  }

  napi_value output;
  if (napi_create_object(env, &output) != napi_ok ||
      !set_bigint(env, output, "sleepEpoch", after) ||
      !set_number(env, output, "monotonicMs", monotonic) ||
      !set_number(env, output, "wallMs", wall)) return NULL;
  return output;
}

static napi_value
initialize(napi_env env, napi_value exports)
{
  initialize_state();
  napi_property_descriptor properties[] = {
    { "metadata", NULL, metadata, NULL, NULL, NULL, napi_default, NULL },
    { "snapshot", NULL, snapshot, NULL, NULL, NULL, napi_default, NULL },
  };
  if (napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties) != napi_ok) return NULL;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
