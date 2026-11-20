use super::*;

#[test]
fn ranking_knobs_env_override_and_fail_safe() {
    // (cat1 ranking) Solo este test toca estas env vars.
    std::env::set_var("ULTRON_FANOUT_K", "50");
    assert_eq!(env_knob_usize("ULTRON_FANOUT_K", 30), 50);
    std::env::set_var("ULTRON_FANOUT_K", "garbage");
    assert_eq!(
        env_knob_usize("ULTRON_FANOUT_K", 30),
        30,
        "basura -> default, no silencio"
    );
    std::env::remove_var("ULTRON_FANOUT_K");
    assert_eq!(env_knob_usize("ULTRON_FANOUT_K", 30), 30);

    std::env::set_var("ULTRON_RRF_K", "20.5");
    assert_eq!(env_knob_f32("ULTRON_RRF_K", 60.0), 20.5);
    std::env::remove_var("ULTRON_RRF_K");
    assert_eq!(env_knob_f32("ULTRON_RRF_K", 60.0), 60.0);
}
