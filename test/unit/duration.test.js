const { expect } = require("chai");
const {
    assertDurationDays,
    DURATION_DAYS_MIN,
    DURATION_DAYS_MAX,
    SECONDS_PER_DAY,
} = require("../../src/sdk/duration");

describe("duration / assertDurationDays", function () {
    describe("constants", function () {
        it("exports the contract's expected min/max", function () {
            expect(DURATION_DAYS_MIN).to.equal(7);
            expect(DURATION_DAYS_MAX).to.equal(365);
            expect(SECONDS_PER_DAY).to.equal(86400);
        });
    });

    describe("valid input", function () {
        it("accepts the minimum (7)", function () {
            expect(assertDurationDays(7)).to.equal(7);
        });
        it("accepts a typical mid value (30)", function () {
            expect(assertDurationDays(30)).to.equal(30);
        });
        it("accepts the maximum (365)", function () {
            expect(assertDurationDays(365)).to.equal(365);
        });
        it("coerces bigint input to number", function () {
            expect(assertDurationDays(7n)).to.equal(7);
            expect(assertDurationDays(365n)).to.equal(365);
        });
    });

    describe("below minimum", function () {
        it("rejects 0", function () {
            expect(() => assertDurationDays(0)).to.throw(RangeError, /below min 7/);
        });
        it("rejects 6", function () {
            expect(() => assertDurationDays(6)).to.throw(RangeError, /below min 7/);
        });
        it("rejects negative numbers", function () {
            expect(() => assertDurationDays(-1)).to.throw(RangeError, /below min 7/);
        });
    });

    describe("above maximum", function () {
        it("rejects 366", function () {
            expect(() => assertDurationDays(366)).to.throw(RangeError, /exceeds max 365/);
        });
        it("rejects 1000", function () {
            expect(() => assertDurationDays(1000)).to.throw(RangeError, /exceeds max 365/);
        });
    });

    describe("seconds-shaped input (the footgun)", function () {
        it("rejects 604800 (= 7 days in seconds) with a helpful hint", function () {
            const fn = () => assertDurationDays(7 * SECONDS_PER_DAY);
            expect(fn).to.throw(RangeError, /exceeds max 365/);
            expect(fn).to.throw(/days expressed in seconds/);
            expect(fn).to.throw(/7 days/);
        });
        it("rejects 2592000 (= 30 days in seconds) with the hint", function () {
            const fn = () => assertDurationDays(30 * SECONDS_PER_DAY);
            expect(fn).to.throw(/30 days expressed in seconds/);
        });
        it("does NOT add the seconds hint when the over-max value is not a clean multiple of 86400", function () {
            const fn = () => assertDurationDays(500);
            expect(fn).to.throw(/exceeds max 365/);
            expect(fn).to.not.throw(/expressed in seconds/);
        });
    });

    describe("invalid types", function () {
        it("rejects string '7'", function () {
            expect(() => assertDurationDays('7')).to.throw(RangeError, /must be an integer/);
        });
        it("rejects null", function () {
            expect(() => assertDurationDays(null)).to.throw(RangeError, /must be an integer/);
        });
        it("rejects undefined", function () {
            expect(() => assertDurationDays(undefined)).to.throw(RangeError, /must be an integer/);
        });
        it("rejects NaN", function () {
            expect(() => assertDurationDays(NaN)).to.throw(RangeError, /must be an integer/);
        });
        it("rejects Infinity", function () {
            expect(() => assertDurationDays(Infinity)).to.throw(RangeError, /must be an integer/);
        });
        it("rejects floats", function () {
            expect(() => assertDurationDays(7.5)).to.throw(RangeError, /must be an integer/);
        });
    });

    describe("ctx parameter", function () {
        it("uses the provided context label in the error message", function () {
            expect(() => assertDurationDays(0, 'MyAgent.borrow')).to.throw(
                RangeError,
                /MyAgent\.borrow: durationDays=0/
            );
        });
        it("defaults to 'requestLoan' when no ctx is provided", function () {
            expect(() => assertDurationDays(0)).to.throw(RangeError, /requestLoan: durationDays=0/);
        });
    });
});
