import unittest
import tempfile
from pathlib import Path

import numpy as np

from SDAT.core import compute_empirical_probability, sdat_from_matrix, sdat_from_vector
from SDAT.examples import run_vector_example
from SDAT.io_utils import load_timeseries_table


def matlab_style_reference_vector(td, sc):
    """Independent literal translation of MATLAB SPI.m/SDAT.m for parity tests."""
    from statistics import NormalDist

    td = np.asarray(td, dtype=float).reshape(-1)
    n = len(td)
    si = np.zeros(n, dtype=float)

    if np.sum(td >= 0) / len(td) != 1:
        si[n - 1] = np.nan
        return si

    si[: sc - 1] = np.nan

    columns = []
    for i in range(sc):
        columns.append(td[i : len(td) - sc + i + 1])
    y = np.sum(np.column_stack(columns), axis=1)

    nn = len(y)
    si1 = np.zeros(nn, dtype=float)
    for k in range(12):
        d = y[k:nn:12]
        nnn = len(d)
        bp = np.zeros(nnn, dtype=float)
        for i in range(nnn):
            bp[i] = np.sum(d <= d[i])
        si1[k:nn:12] = (bp - 0.44) / (nnn + 0.12)

    inv = NormalDist().inv_cdf
    si[sc - 1 :] = np.array([inv(float(p)) for p in si1], dtype=float)
    return si


def matlab_style_reference_matrix(prec, sc):
    """Independent literal translation of MATLAB SDAT_Matrix.m."""
    prec = np.asarray(prec, dtype=float)
    n, m, p0 = prec.shape
    si = np.zeros((n, m, p0), dtype=float)

    for ii in range(n):
        for jj in range(m):
            td = prec[ii, jj, :].reshape(-1)
            if np.sum(td >= 0) / len(td) != 1:
                si[ii, jj, :] = np.nan
            else:
                si[ii, jj, :] = matlab_style_reference_vector(td, sc)
    return si


class TestSDATCore(unittest.TestCase):
    def test_empirical_probability_formula(self):
        d = np.array([1.0, 2.0, 2.0, 5.0], dtype=float)
        y = compute_empirical_probability(d)
        # bp = [1, 3, 3, 4]
        expected = (np.array([1, 3, 3, 4], dtype=float) - 0.44) / (4 + 0.12)
        np.testing.assert_allclose(y, expected, rtol=0, atol=1e-12)

    def test_vector_from_sample_data(self):
        # Synthetic monthly series (all non-negative) for stable local test.
        td = np.array([float((i % 12) + 1) for i in range(60)], dtype=float)
        si = sdat_from_vector(td, sc=6)

        self.assertEqual(si.shape, (60,))
        self.assertTrue(np.all(np.isnan(si[:5])))
        self.assertTrue(np.isfinite(si[5:]).all())

    def test_vector_invalid_data_behavior_matches_matlab(self):
        # MATLAB SPI.m behavior: for invalid vector only last item is NaN.
        td = np.array([1.0, -1.0, 2.0, 3.0], dtype=float)
        si = sdat_from_vector(td, sc=2)
        self.assertTrue(np.isnan(si[-1]))
        self.assertTrue(np.isfinite(si[:-1]).all())

    def test_vector_matches_independent_matlab_style_reference(self):
        td = np.array([float(((i * 7) % 19) + (i % 5)) for i in range(72)], dtype=float)
        for sc in (1, 3, 6, 12):
            actual = sdat_from_vector(td, sc=sc)
            expected = matlab_style_reference_vector(td, sc=sc)
            np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12, equal_nan=True)

    def test_matrix_invalid_pixel_behavior_matches_matlab(self):
        # Build (n, m, p0) with one invalid cell (contains negative value).
        prec = np.ones((2, 2, 24), dtype=float)
        prec[0, 1, 5] = -0.2

        si = sdat_from_matrix(prec, sc=3)
        self.assertEqual(si.shape, prec.shape)
        self.assertTrue(np.isnan(si[0, 1, :]).all())
        self.assertTrue(np.isnan(si[0, 0, :2]).all())

    def test_matrix_matches_independent_matlab_style_reference(self):
        base = np.array([float(((i * 5) % 23) + 1) for i in range(48)], dtype=float)
        prec = np.stack(
            [
                np.stack([base, base + 2.0, base[::-1]], axis=0),
                np.stack([base + 4.0, base + 6.0, base + 8.0], axis=0),
            ],
            axis=0,
        )
        actual = sdat_from_matrix(prec, sc=3)
        expected = matlab_style_reference_matrix(prec, sc=3)
        np.testing.assert_allclose(actual, expected, rtol=0, atol=1e-12, equal_nan=True)

    def test_load_timeseries_table_with_id_and_date_sort(self):
        csv_text = (
            "ID,DATE,VALUE,LAT,LONG,ELEV\n"
            "A,2020-03-01,3.0,10,20,100\n"
            "B,2020-01-01,7.0,11,21,120\n"
            "A,2020-01-01,1.0,10,20,100\n"
            "A,2020-02-01,2.0,10,20,100\n"
        )
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "sample.csv"
            path.write_text(csv_text, encoding="utf-8")

            values = load_timeseries_table(
                path,
                value_col="VALUE",
                date_col="DATE",
                id_col="ID",
                id_value="A",
            )

        np.testing.assert_allclose(values, np.array([1.0, 2.0, 3.0], dtype=float))

    def test_vector_example_uses_matlab_sample_path(self):
        si = run_vector_example()
        self.assertEqual(si.ndim, 1)
        self.assertGreater(si.size, 0)
        self.assertTrue(np.isnan(si[:5]).all())


if __name__ == "__main__":
    unittest.main()
