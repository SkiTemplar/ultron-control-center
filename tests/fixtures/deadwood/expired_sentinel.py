# sample fixture — sentinel with remove-after already in the past
def live_helper():
    return 42

# @ULTRON-DEPRECATED:13.0.0
#   reason: legacy logger replaced by structlog
#   replaced-by: ultron.logger.get_logger()
#   remove-after: 2020-01-01
def old_logger():
    print("noop")
# @ULTRON-DEPRECATED-END


def another_live():
    return "ok"
