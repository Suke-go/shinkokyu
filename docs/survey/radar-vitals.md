# Radar vital signs survey (breathing cycles and heart rate from one mmWave FMCW radar, seated person, body movement)

Date: 2026-11-20. "Read" = I read the article text this session. "Snippet" = only a search-result summary was seen; open the paper before citing a number from it. "Ours" = measured on this project's own captures (radar/captures, PTM RFR79ITR34-30U = TI IWR1843, 40 frames/s, 4.8 cm range bins, 1 TX / 4 RX).

Questions: (1) can breathing and heart rate come out of one pipeline, (2) how is body movement kept out of the breathing wave, (3) is beat-to-beat heart rate variability realistic, (4) where to put the radar.

## 1. Sources

| Source | What it is | Status |
|---|---|---|
| Hao et al., "mmWave-RM", Sensors 2024, [doi:10.3390/s24134315](https://doi.org/10.3390/s24134315) ([PMC11243972](https://pmc.ncbi.nlm.nih.gov/articles/PMC11243972/)) | Same radar (IWR1843BOOST + DCA1000). Seated, radar 0.8 m in front, aimed at the chest. Phase difference between frames -> elliptic band-pass 0.1-0.5 Hz -> smoothing -> a breath = a peak and the trough after it; peaks under 0.2 of the normalised amplitude ignored. Reference: smartwatch breathing exercise, mean error 0.5 breaths per 25 s recording. No heart rate, no motion handling ("subjects only needed to avoid significant limb movements"), no confidence measure. Four breathing patterns classified at 94.75%. Clothing and distance tested; 0.8 m chosen. | Read (first half verbatim, second half via summary) |
| Alizadeh et al., "Remote monitoring of human vital signs using mm-wave FMCW radar", IEEE Access 2019, doi:10.1109/ACCESS.2019.2912956; [thesis](https://uwspace.uwaterloo.ca/handle/10012/14392) | TI mmWave radar, lying subjects. HR / BR accuracy above 94% / 96% across sleep positions (thesis figure). | Snippet |
| [TI Vital Signs Lab support guide](https://dev.ti.com/tirex/explore/content/mmwave_industrial_toolbox_4_8_0/labs/vital_signs/68xx_vital_signs/docs/vital_signs_68xx_SupportGuide.html) | Reference firmware. A motion-detection block discards data segments corrupted by large movement. Not supported beyond 1 m. Outputs include an inter-peak estimate and an autocorrelation confidence for breathing. Frozen since 2021. | Snippet |
| Pi-ViMo, [arXiv:2303.13816](https://arxiv.org/pdf/2303.13816) | Argues one range bin is fragile; coherently combines neighbouring bins to estimate chest-wall displacement. | Snippet |
| Multidimensional physiology-inspired MIMO bio-radar, [arXiv:2510.15278](https://arxiv.org/pdf/2510.15278) | The chest is many scatterers at close range, not one; fuses several range bins by maximum-ratio combining and selects channels by respiratory / heartbeat SNR. Says the single-scatterer simplification can cost 20% or more in heart rate. | Snippet |
| Alidoustaghdam et al., [arXiv:2303.09400](https://arxiv.org/pdf/2303.09400) | MIMO: pick the strongest range bin, then steer a beam at the chest (located by a CNN on point clouds). Beam toward the chest raises signal-to-interference ratio. | Snippet |
| Scalable multisubject monitoring, [arXiv:2511.21314](https://arxiv.org/pdf/2511.21314) | Locates people as peaks of the variance of the frame-to-frame phase difference over range-azimuth bins; empty bins show negligible variance. | Snippet |
| Frontiers in Physiology 2023, [doi:10.3389/fphys.2023.1206471](https://www.frontiersin.org/journals/physiology/articles/10.3389/fphys.2023.1206471/pdf) | Range bin chosen after first deciding the target's state (still / moving), then by SNR. | Snippet |
| Motion cancellation review, Sensors 2025, [PMC11991636](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11991636/) | Review of body-motion cancellation for CW and FMCW vital-sign radar. Body motion is larger than breathing or heartbeat and is "the most formidable challenge". | Snippet |
| Beijing Inst. of Technology, [random body movement cancellation for FMCW](https://pure.bit.edu.cn/en/publications/random-body-movement-cancellation-method-for-fmcw-radar-vital-sig/) | Small movement inside a range bin: scale it down by its energy. Movement that leaves the bin: track the bin. | Snippet |
| Rong & Bliss, [EUSIPCO 2023](https://eurasip.org/Proceedings/Eusipco/Eusipco2023/pdfs/0000790.pdf) | Estimate the bulk body motion before the range transform and cancel it in the complex domain. Simulation, SFCW; said to extend to FMCW. | Snippet |
| IEEE Access 2021, [multi-channel 77 GHz LFMCW](https://doaj.org/article/182276b8d9bc4722b130478e8dadfc6f) | Kalman smoother across receivers to remove phase outliers, then a hidden Markov model for the rates. | Snippet |
| mmHRV, IEEE IoT-J 2021, [paper](https://originwirelessai.com/wp-content/uploads/2024/04/mmHRV_Fengyu_2021.pdf) | Heart rate variability from mmWave. Median inter-beat-interval error 28 ms (90th percentile about 80 ms), 11 participants, still. | Snippet |
| FMCW trade-offs, [arXiv:2603.09791](https://arxiv.org/abs/2603.09791) (2026) | Quantifies distance and chirp count. Variability metrics (heart and respiratory rate variability) stay less accurate, above 15-30% error. | Snippet |
| Iwata et al., IEEE Access 2025 ([Kyoto Univ. repository](https://repository.kulib.kyoto-u.ac.jp/dspace/bitstream/2433/294797/1/ACCESS.2025.3575932.pdf)); [arXiv:2407.07380](https://arxiv.org/html/2407.07380v1) | Heartbeat from the absolute value of the second derivative of the complex radar signal (emphasises the heartbeat's higher harmonics, which breathing harmonics do not reach), then variational mode extraction. Inter-beat-interval RMSE down 23% against phase-based methods, 11 participants. | Snippet |
| Respiration-harmonic papers: SG-VMD (IEEE TMTT 2023), improved VME ([IEEE Access 2024](https://doaj.org/article/a8c382e29b02437aa084a8f1b11d29b1)), [arXiv:2503.07062](https://pdf.arxiv.org/pdf/2503.07062) | Harmonics of breathing fall in the heart band and bias the heart rate; so do sums and differences of harmonics. Fixes: variational mode decomposition plus a check on the heartbeat's second harmonic; adaptive harmonic enhancement. | Snippet |
| 77 GHz seated-in-office study, [PMC9572116](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9572116/) | Person sitting in a chair in an office: mean relative error 1.33% (breathing) and 1.96% (heart rate) against a wristband. Still subject. | Snippet |
| Camera-assisted mmWave, [arXiv:2311.11275](https://arxiv.org/html/2311.11275v2) | Body-motion noise blocks the vital signal; fusing a camera gives 90th-percentile errors under 0.5 breaths/min and 6 beats/min. | Snippet |
| Grassmann et al., "Respiratory changes in response to cognitive load: a systematic review", [PMC4923594](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC4923594/) | Respiratory variability is rarely studied; total variability of the rate is not systematically changed by cognitive load, the correlated fraction decreases. Mental stress and mental load are different states. | Snippet |
| Bioradar stress / workload, Biomed. Signal Process. Control 2018, [doi:10.1016/j.bspc.2018.03.006](https://doi.org/10.1016/j.bspc.2018.03.006) | Stress detected from radar respiration patterns alone; a workload study reports accuracy 0.87 (calm vs mental arithmetic). | Snippet |

Not obtained: https://www.nature.com/articles/s41598-025-09112-w (redirects to a sign-in check; a search for the identifier found nothing).

## 2. Findings

### One pipeline for breathing and heart rate
- Every system above takes both from the same chest phase history: the low band (about 0.1-0.5 Hz) of the displacement is breathing, the heartbeat is taken from the same signal's higher band. So yes, one acquisition and one chest track serve both; only the last step differs.
- The heart-rate step is where they differ, and plain "spectrum peak in 0.8-2.5 Hz" (what vitals.py does) is the weakest choice: breathing harmonics and their intermodulation products sit in that band. The alternatives in the literature: decomposition (VMD family) with a second-harmonic check; or differentiating twice so the heartbeat's higher harmonics dominate (Iwata et al.), which also gives beat timing.
- Ours: taking the heart rate from the chest bins found by the breathing tracker, instead of the power-weighted bins, did not help consistently (30 s windows on five captures: sometimes the peak share rose, e.g. 0.28 -> 0.45, sometimes it fell, 0.67 -> 0.50). Bin choice is not the heart rate's main problem; the estimator is.

### Which range bin is the chest
- Strongest bin and largest phase variance are the common rules and are known to pick the wrong bin when neighbours look alike. Proposed fixes: combine several bins (Pi-ViMo, maximum-ratio combining), select by respiratory SNR or periodicity, steer a MIMO beam at the chest.
- Ours: on the cleanest capture the breathing wave (2.8 s period, +-2 mm) was in the bins at the near edge of the body (0.33-0.43 m), not in the strongest bins (0.48-0.57 m). breathing.py selects by regularity of the wave and adds the bins that move with it, which is the "periodicity + combine neighbours" line of the literature.
- Not used yet: the kit has 3 TX. With them the array is 12 virtual antennas (15 degrees), enough to steer at the chest and away from the arms. The papers that report the best robustness use this.

### Body movement in the breathing wave
- What is actually done, in order of how often: (a) detect movement and discard that stretch (TI lab, most systems); (b) remove outliers / smooth the phase (Kalman smoother, energy scaling); (c) follow the body across range bins; (d) combine bins or beams so one corrupted bin does not decide; (e) estimate the bulk motion and subtract it (simulation only); (f) add a second sensor (camera, second radar).
- No source was found that tests a person typing. The seated-office results are for still subjects. Typing accuracy is unknown, not merely unreported in our hands.
- Ours: breathing.py does (a) and (b) (clip steps above 25 mm/s, Gaussian baseline removal, skip breaths during which the smoothed chest speed exceeds 12 mm/s). Subtracting the motion of the rest of the body (bins that reflect strongly but do not move with the chest) raised the regularity of the wave where such bins existed (0.47 -> 0.57, 0.40 -> 0.48, 0.36 -> 0.45, 0.45 -> 0.52), but in most windows every strong bin moved with the chest and there was nothing to subtract. With one TX and 4.8 cm bins the body is not resolved well enough for this to be the main tool.

### Heart rate variability
- Reported under good conditions (still, close, facing): median inter-beat error about 28 ms (mmHRV); RMSSD errors of a few ms sitting are claimed in one conference paper. A 2026 study still puts variability metrics above 15-30% error. For RMSSD-type stress indices, 28 ms per beat is a large error.
- None of this is with movement. Variability from this radar during typing should be treated as not available until shown otherwise against a chest-strap reference.
- Breathing-based indices have radar precedents for stress and workload (2018 bioradar papers), and the breath-by-breath intervals they need are what breathing.py produces. The systematic review cautions that breathing-rate variability does not move consistently with cognitive load, so which index to use is a study-design question, not a signal-processing one.

### Placement
- Typical: chest height, facing, 0.4-1 m. Same-radar paper: 0.8 m after comparing 0.4-1.5 m (signal energy falls with distance). TI: not beyond 1 m. Most methods assume the subject faces the radar.
- Nothing found on behind-the-chair or under-desk placement for seated work. Our kit's vertical beam is about +-10 degrees, so height matters more than in the papers' wider-beam boards.

## 3. What this means for this project

1. Keep one acquisition and one chest track; output breathing cycles from it now, heart rate from it as a second product.
2. Validate breathing first, against paced breathing (no extra hardware), including deep breaths, because the movement threshold (12 mm/s) is a guess.
3. For body movement during typing, the options with evidence are discard-and-report (done), multi-bin / beam combining (needs the 3 TX configuration), or a second sensor. Decide after seeing how much of a typing session survives (a): report.py prints that share as `moved`.
4. Replace the heart-rate step with a harmonic-aware one (second derivative, or second-harmonic check) only after a reference exists; without one it cannot be tuned.
5. Treat beat-to-beat variability as a stretch goal, and breathing intervals as the primary stress-related measure.
