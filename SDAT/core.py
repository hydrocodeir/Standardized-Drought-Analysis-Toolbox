"""
Core SDAT computations translated from MATLAB to Python.

Important:
- This module intentionally follows the original MATLAB code structure very
  closely, including loop order and indexing behavior (translated to 0-based).
- It is designed for reproducibility with SDAT MATLAB results.
"""

from __future__ import annotations

from statistics import NormalDist
from typing import Iterable

import numpy as np


def normal_inverse_cdf(probabilities: np.ndarray) -> np.ndarray:
    """
    MATLAB `norminv` equivalent.

    We first try scipy for speed. If SciPy is unavailable, we fall back to
    Python's stdlib `statistics.NormalDist().inv_cdf`.
    """
    p = np.asarray(probabilities, dtype=float)
    # Clip tiny numerical excursions to keep inverse CDF finite.
    p = np.clip(p, 1e-12, 1.0 - 1e-12)

    try:
        from scipy.stats import norm  # type: ignore

        return norm.ppf(p)
    except Exception:
        inv = NormalDist().inv_cdf
        return np.array([inv(float(x)) for x in p], dtype=float)


def compute_empirical_probability(d: np.ndarray) -> np.ndarray:
    """
    Compute empirical nonparametric probability for one month-group vector.

    MATLAB block reproduced:
      nnn = length(d)
      bp = zeros(nnn,1)
      for i=1:nnn
          bp(i,1)=sum(d(:,1)<=d(i,1));
      end
      y=(bp-0.44)./(nnn+0.12)
    """
    d = np.asarray(d, dtype=float).reshape(-1)
    nnn = len(d)
    bp = np.zeros(nnn, dtype=float)

    for i in range(nnn):
        bp[i] = np.sum(d <= d[i])

    y = (bp - 0.44) / (nnn + 0.12)
    return y


def _moving_sum_by_scale(td: np.ndarray, sc: int) -> np.ndarray:
    """
    Reproduce MATLAB:
      A1=[]
      for i=1:sc
          A1=[A1,td(i:length(td)-sc+i)];
      end
      Y=sum(A1,2);
    """
    n = len(td)
    a1_columns = []
    for i in range(sc):
        start = i
        stop = n - sc + i + 1
        a1_columns.append(td[start:stop])

    a1 = np.column_stack(a1_columns)
    y = np.sum(a1, axis=1)
    return y


def sdat_from_vector(td: Iterable[float], sc: int = 6) -> np.ndarray:
    """
    Python equivalent of SDAT MATLAB/SPI.m for a single time series.

    Parameters
    ----------
    td : iterable of float
        Input vector (e.g., precipitation / soil moisture / runoff / etc.).
    sc : int
        Timescale (e.g., 3-month, 6-month).

    Returns
    -------
    np.ndarray
        1D standardized indicator (same length as input).
    """
    td = np.asarray(list(td), dtype=float).reshape(-1)
    n = len(td)
    si = np.zeros(n, dtype=float)

    # MATLAB exact logic:
    # if length(td(td>=0))/length(td)~=1
    #    SI(n,1)=nan;
    # else ...
    # NOTE: In SPI.m this sets only last element to NaN (original behavior).
    if np.sum(td >= 0) / len(td) != 1:
        si[n - 1] = np.nan
        return si

    # SI(1:sc-1,1)=nan;
    si[: sc - 1] = np.nan

    # Moving-sum aggregation at scale sc
    y = _moving_sum_by_scale(td, sc)

    # Compute monthly empirical probabilities then Gaussian transform
    nn = len(y)
    si1 = np.zeros(nn, dtype=float)

    # MATLAB: for k=1:12, d=Y(k:12:nn), ...
    for k in range(12):
        d = y[k:nn:12]
        probs = compute_empirical_probability(d)
        si1[k:nn:12] = probs

    si1 = normal_inverse_cdf(si1)

    # SI(sc:end,1)=SI1;
    si[sc - 1 :] = si1
    return si


def sdat_from_matrix(prec: np.ndarray, sc: int = 3) -> np.ndarray:
    """
    Python equivalent of SDAT MATLAB/SDAT_Matrix/SDAT_Matrix.m.

    Expected input shape: (n, m, p0)
      n, m: spatial dimensions
      p0: temporal dimension
    """
    prec = np.asarray(prec, dtype=float)
    if prec.ndim != 3:
        raise ValueError("Input matrix must be 3D with shape (n, m, p0).")

    n, m, p0 = prec.shape
    si = np.zeros((n, m, p0), dtype=float)

    for ii in range(n):
        for jj in range(m):
            td = prec[ii, jj, :].reshape(p0, 1)

            # MATLAB:
            # if length(td(td>=0))/length(td)~=1
            #     SI(ii,jj,:)=nan;
            if np.sum(td >= 0) / len(td) != 1:
                si[ii, jj, :] = np.nan
                continue

            # SI(ii,jj,1:sc-1)=nan;
            si[ii, jj, : sc - 1] = np.nan

            # Scale aggregation and standardized transformation
            y = _moving_sum_by_scale(td.reshape(-1), sc)
            nn = len(y)
            si1 = np.zeros(nn, dtype=float)

            for k in range(12):
                d = y[k:nn:12]
                probs = compute_empirical_probability(d)
                si1[k:nn:12] = probs

            si1 = normal_inverse_cdf(si1)

            # SI(ii,jj,sc:end)=SI1;
            si[ii, jj, sc - 1 :] = si1

    return si

