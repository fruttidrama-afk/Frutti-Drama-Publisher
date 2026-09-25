# FLOW GOLDEN TEST

Run exactly one paid generation after any critical change to project resolution, prompt targeting, settings, submit selector, consent, asset correlation, download, or serial locking.

Pass only if all succeed:
1. persistent session valid;
2. exact project verified;
3. project title unchanged;
4. real prompt composer verified;
5. Video/model/ratio/duration/count verified;
6. prompt inserted/read back;
7. pre-submit baseline persisted;
8. exactly-once boundary persisted;
9. exact right arrow clicked once;
10. current consent handled or validly absent;
11. unique post-baseline project video tile observed;
12. no second submit;
13. same asset opened from project grid;
14. MP4 downloaded;
15. MP4 validated;
16. final public title/description/hashtags generated;
17. Review shows playable video and final metadata;
18. lifecycle REVIEW_READY;
19. serial gate released.

Only then set FLOW_AUTOMATION_HEALTHY=true.

## Daily credit-cycle gate checks

Before declaring the autonomous daily scheduler healthy, also verify:

20. local midnight alone does not open a new ordinary generation batch;
21. an unchanged large paid/monthly balance does not open the batch;
22. a trustworthy live Flow balance is persisted as credit-cycle evidence;
23. after a completed 3-video batch, the post-batch Flow balance is captured;
24. a refill consistent with the 50-credit daily allocation (including a net ~45 increase after 3×15 spend) opens exactly one new credit cycle;
25. exactly three ordinary generations close the default cycle;
26. restart preserves the same cycle ID/opened_at/baseline;
27. Unusual Activity cooldown overrides a detected refill;
28. /factory/health exposes daily_flow_credit_refresh_gate=true, calendar_midnight_does_not_open_batch=true, and paid_monthly_credits_protected_until_daily_refresh=true.

A Publisher fails the Golden Test if calendar rollover alone can authorize an ordinary automatic Flow submit.
