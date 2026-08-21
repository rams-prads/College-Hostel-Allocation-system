/**
 * Geo.gs - offline distance-from-hometown, with no paid geocoding API.
 *
 * Indian PIN codes are hierarchical: the first three digits identify a sorting
 * district. That is enough resolution to answer the only question the policy
 * actually asks - "how far from Delhi does this student live" - so we ship a
 * lookup table of district centroids instead of calling a geocoding service.
 *
 * ACCURACY NOTE: the coordinates below are APPROXIMATE district centroids, good
 * to roughly a few tens of kilometres. They are used for distance BANDING in the
 * merit score, never for navigation. A student near a district boundary may be
 * scored off a centroid some distance from their actual address; this is
 * acceptable for scoring and is documented for the grievance process.
 */

/** GGSIPU campus coordinates (approximate). */
var CAMPUSES = {
  DWARKA: { name: 'Dwarka Campus', lat: 28.5921, lng: 77.0460 },
  EDC:    { name: 'East Delhi Campus', lat: 28.6236, lng: 77.3060 }
};

/**
 * [pinPrefix, lat, lng, district, state]
 * Approximate centroids for the three-digit prefixes that cover the great
 * majority of Indian applicants. Admins may add rows directly in the sheet.
 */
var PINCODE_GEO = [
  // Delhi NCR
  ['110', 28.6139, 77.2090, 'Delhi', 'Delhi'],
  ['111', 28.6500, 77.2300, 'Delhi', 'Delhi'],
  ['121', 28.4089, 77.3178, 'Faridabad', 'Haryana'],
  ['122', 28.4595, 77.0266, 'Gurugram', 'Haryana'],
  ['201', 28.6692, 77.4538, 'Ghaziabad', 'Uttar Pradesh'],
  ['203', 28.4039, 77.8550, 'Bulandshahr', 'Uttar Pradesh'],
  ['245', 28.7300, 77.7800, 'Hapur', 'Uttar Pradesh'],
  ['250', 28.9845, 77.7064, 'Meerut', 'Uttar Pradesh'],
  ['131', 28.9931, 77.0151, 'Sonipat', 'Haryana'],

  // Haryana / Punjab / Chandigarh / HP / J&K
  ['124', 28.8955, 76.6066, 'Rohtak', 'Haryana'],
  ['125', 29.1492, 75.7217, 'Hisar', 'Haryana'],
  ['132', 29.6857, 76.9905, 'Karnal', 'Haryana'],
  ['133', 30.3782, 76.7767, 'Ambala', 'Haryana'],
  ['134', 30.6942, 76.8606, 'Panchkula', 'Haryana'],
  ['136', 29.9695, 76.8783, 'Kurukshetra', 'Haryana'],
  ['140', 30.9661, 76.5231, 'Rupnagar', 'Punjab'],
  ['141', 30.9010, 75.8573, 'Ludhiana', 'Punjab'],
  ['143', 31.6340, 74.8723, 'Amritsar', 'Punjab'],
  ['144', 31.3260, 75.5762, 'Jalandhar', 'Punjab'],
  ['146', 31.5320, 75.9120, 'Hoshiarpur', 'Punjab'],
  ['147', 30.3398, 76.3869, 'Patiala', 'Punjab'],
  ['151', 30.2110, 74.9455, 'Bathinda', 'Punjab'],
  ['160', 30.7333, 76.7794, 'Chandigarh', 'Chandigarh'],
  ['171', 31.1048, 77.1734, 'Shimla', 'Himachal Pradesh'],
  ['173', 30.9084, 77.0999, 'Solan', 'Himachal Pradesh'],
  ['175', 31.7080, 76.9320, 'Mandi', 'Himachal Pradesh'],
  ['176', 32.0998, 76.2691, 'Kangra', 'Himachal Pradesh'],
  ['180', 32.7266, 74.8570, 'Jammu', 'Jammu & Kashmir'],
  ['190', 34.0837, 74.7973, 'Srinagar', 'Jammu & Kashmir'],

  // Uttar Pradesh / Uttarakhand
  ['202', 27.8974, 78.0880, 'Aligarh', 'Uttar Pradesh'],
  ['208', 26.4499, 80.3319, 'Kanpur', 'Uttar Pradesh'],
  ['211', 25.4358, 81.8463, 'Prayagraj', 'Uttar Pradesh'],
  ['221', 25.3176, 82.9739, 'Varanasi', 'Uttar Pradesh'],
  ['224', 26.7922, 82.1998, 'Ayodhya', 'Uttar Pradesh'],
  ['226', 26.8467, 80.9462, 'Lucknow', 'Uttar Pradesh'],
  ['229', 26.2309, 81.2338, 'Rae Bareli', 'Uttar Pradesh'],
  ['231', 25.1460, 82.5690, 'Mirzapur', 'Uttar Pradesh'],
  ['233', 25.5880, 83.5776, 'Ghazipur', 'Uttar Pradesh'],
  ['243', 28.3670, 79.4304, 'Bareilly', 'Uttar Pradesh'],
  ['244', 28.8386, 78.7733, 'Moradabad', 'Uttar Pradesh'],
  ['247', 29.9640, 77.5460, 'Saharanpur', 'Uttar Pradesh'],
  ['248', 30.3165, 78.0322, 'Dehradun', 'Uttarakhand'],
  ['249', 29.9457, 78.1642, 'Haridwar', 'Uttarakhand'],
  ['251', 29.4727, 77.7085, 'Muzaffarnagar', 'Uttar Pradesh'],
  ['263', 29.3919, 79.4542, 'Nainital', 'Uttarakhand'],
  ['273', 26.7606, 83.3732, 'Gorakhpur', 'Uttar Pradesh'],
  ['276', 26.0685, 83.1836, 'Azamgarh', 'Uttar Pradesh'],
  ['281', 27.4924, 77.6737, 'Mathura', 'Uttar Pradesh'],
  ['282', 27.1767, 78.0081, 'Agra', 'Uttar Pradesh'],
  ['284', 25.4484, 78.5685, 'Jhansi', 'Uttar Pradesh'],

  // Rajasthan
  ['301', 27.5530, 76.6346, 'Alwar', 'Rajasthan'],
  ['302', 26.9124, 75.7873, 'Jaipur', 'Rajasthan'],
  ['305', 26.4499, 74.6399, 'Ajmer', 'Rajasthan'],
  ['313', 24.5854, 73.7125, 'Udaipur', 'Rajasthan'],
  ['324', 25.2138, 75.8648, 'Kota', 'Rajasthan'],
  ['333', 28.1289, 75.3995, 'Jhunjhunu', 'Rajasthan'],
  ['334', 28.0229, 73.3119, 'Bikaner', 'Rajasthan'],
  ['342', 26.2389, 73.0243, 'Jodhpur', 'Rajasthan'],
  ['345', 26.9157, 70.9083, 'Jaisalmer', 'Rajasthan'],

  // Gujarat
  ['360', 22.3039, 70.8022, 'Rajkot', 'Gujarat'],
  ['364', 21.7645, 72.1519, 'Bhavnagar', 'Gujarat'],
  ['370', 23.2419, 69.6669, 'Kutch', 'Gujarat'],
  ['380', 23.0225, 72.5714, 'Ahmedabad', 'Gujarat'],
  ['382', 23.2156, 72.6369, 'Gandhinagar', 'Gujarat'],
  ['390', 22.3072, 73.1812, 'Vadodara', 'Gujarat'],
  ['395', 21.1702, 72.8311, 'Surat', 'Gujarat'],

  // Maharashtra / Goa
  ['400', 19.0760, 72.8777, 'Mumbai', 'Maharashtra'],
  ['403', 15.2993, 74.1240, 'Panaji', 'Goa'],
  ['411', 18.5204, 73.8567, 'Pune', 'Maharashtra'],
  ['413', 17.6599, 75.9064, 'Solapur', 'Maharashtra'],
  ['416', 16.7050, 74.2433, 'Kolhapur', 'Maharashtra'],
  ['421', 19.2183, 73.0878, 'Thane', 'Maharashtra'],
  ['422', 19.9975, 73.7898, 'Nashik', 'Maharashtra'],
  ['425', 21.0077, 75.5626, 'Jalgaon', 'Maharashtra'],
  ['431', 19.8762, 75.3433, 'Chhatrapati Sambhajinagar', 'Maharashtra'],
  ['440', 21.1458, 79.0882, 'Nagpur', 'Maharashtra'],
  ['444', 20.7096, 77.0021, 'Akola', 'Maharashtra'],

  // Madhya Pradesh / Chhattisgarh
  ['452', 22.7196, 75.8577, 'Indore', 'Madhya Pradesh'],
  ['456', 23.1793, 75.7849, 'Ujjain', 'Madhya Pradesh'],
  ['462', 23.2599, 77.4126, 'Bhopal', 'Madhya Pradesh'],
  ['470', 23.8388, 78.7378, 'Sagar', 'Madhya Pradesh'],
  ['474', 26.2183, 78.1828, 'Gwalior', 'Madhya Pradesh'],
  ['482', 23.1815, 79.9864, 'Jabalpur', 'Madhya Pradesh'],
  ['486', 24.5362, 81.3037, 'Rewa', 'Madhya Pradesh'],
  ['492', 21.2514, 81.6296, 'Raipur', 'Chhattisgarh'],
  ['495', 22.0797, 82.1409, 'Bilaspur', 'Chhattisgarh'],

  // Telangana / Andhra Pradesh
  ['500', 17.3850, 78.4867, 'Hyderabad', 'Telangana'],
  ['506', 17.9689, 79.5941, 'Warangal', 'Telangana'],
  ['515', 14.6819, 77.6006, 'Anantapur', 'Andhra Pradesh'],
  ['517', 13.6288, 79.4192, 'Tirupati', 'Andhra Pradesh'],
  ['520', 16.5062, 80.6480, 'Vijayawada', 'Andhra Pradesh'],
  ['522', 16.3067, 80.4365, 'Guntur', 'Andhra Pradesh'],
  ['530', 17.6868, 83.2185, 'Visakhapatnam', 'Andhra Pradesh'],

  // Karnataka
  ['560', 12.9716, 77.5946, 'Bengaluru', 'Karnataka'],
  ['570', 12.2958, 76.6394, 'Mysuru', 'Karnataka'],
  ['575', 12.9141, 74.8560, 'Mangaluru', 'Karnataka'],
  ['580', 15.3647, 75.1240, 'Hubballi', 'Karnataka'],
  ['590', 15.8497, 74.4977, 'Belagavi', 'Karnataka'],

  // Tamil Nadu / Puducherry / Kerala
  ['600', 13.0827, 80.2707, 'Chennai', 'Tamil Nadu'],
  ['605', 11.9416, 79.8083, 'Puducherry', 'Puducherry'],
  ['620', 10.7905, 78.7047, 'Tiruchirappalli', 'Tamil Nadu'],
  ['625', 9.9252, 78.1198, 'Madurai', 'Tamil Nadu'],
  ['627', 8.7139, 77.7567, 'Tirunelveli', 'Tamil Nadu'],
  ['636', 11.6643, 78.1460, 'Salem', 'Tamil Nadu'],
  ['641', 11.0168, 76.9558, 'Coimbatore', 'Tamil Nadu'],
  ['673', 11.2588, 75.7804, 'Kozhikode', 'Kerala'],
  ['682', 9.9312, 76.2673, 'Kochi', 'Kerala'],
  ['686', 9.5916, 76.5222, 'Kottayam', 'Kerala'],
  ['695', 8.5241, 76.9366, 'Thiruvananthapuram', 'Kerala'],

  // West Bengal / Odisha
  ['700', 22.5726, 88.3639, 'Kolkata', 'West Bengal'],
  ['711', 22.5958, 88.2636, 'Howrah', 'West Bengal'],
  ['713', 23.2599, 87.8615, 'Bardhaman', 'West Bengal'],
  ['721', 22.4257, 87.3199, 'Medinipur', 'West Bengal'],
  ['734', 26.7271, 88.3953, 'Darjeeling', 'West Bengal'],
  ['743', 22.6800, 88.4400, 'North 24 Parganas', 'West Bengal'],
  ['751', 20.2961, 85.8245, 'Bhubaneswar', 'Odisha'],
  ['753', 20.4625, 85.8830, 'Cuttack', 'Odisha'],
  ['768', 21.4669, 83.9812, 'Sambalpur', 'Odisha'],
  ['769', 22.2604, 84.8536, 'Rourkela', 'Odisha'],

  // Bihar / Jharkhand
  ['800', 25.5941, 85.1376, 'Patna', 'Bihar'],
  ['812', 25.2425, 86.9842, 'Bhagalpur', 'Bihar'],
  ['823', 24.7955, 84.9994, 'Gaya', 'Bihar'],
  ['826', 23.7957, 86.4304, 'Dhanbad', 'Jharkhand'],
  ['831', 22.8046, 86.2029, 'Jamshedpur', 'Jharkhand'],
  ['834', 23.3441, 85.3096, 'Ranchi', 'Jharkhand'],
  ['842', 26.1197, 85.3910, 'Muzaffarpur', 'Bihar'],
  ['846', 26.1542, 85.8918, 'Darbhanga', 'Bihar'],
  ['854', 25.7771, 87.4753, 'Purnia', 'Bihar'],

  // North East
  ['781', 26.1445, 91.7362, 'Guwahati', 'Assam'],
  ['785', 26.7509, 94.2037, 'Jorhat', 'Assam'],
  ['786', 27.4728, 94.9120, 'Dibrugarh', 'Assam'],
  ['788', 24.8333, 92.7789, 'Silchar', 'Assam'],
  ['791', 27.0844, 93.6053, 'Itanagar', 'Arunachal Pradesh'],
  ['793', 25.5788, 91.8933, 'Shillong', 'Meghalaya'],
  ['795', 24.8170, 93.9368, 'Imphal', 'Manipur'],
  ['796', 23.7271, 92.7176, 'Aizawl', 'Mizoram'],
  ['797', 25.6751, 94.1086, 'Kohima', 'Nagaland'],
  ['799', 23.8315, 91.2868, 'Agartala', 'Tripura']
];

var Geo = (function () {

  var _index = null;

  /** { pinPrefix: {lat, lng, district, state} } from the sheet, cached. */
  function index() {
    if (_index) return _index;
    _index = {};
    Db.readAll('PincodeGeo').forEach(function (r) {
      _index[String(r.pinPrefix)] = r;
    });
    return _index;
  }

  function invalidate() { _index = null; }

  /** Great-circle distance in km. */
  function haversine(lat1, lng1, lat2, lng2) {
    var R = 6371;
    var toRad = function (d) { return d * Math.PI / 180; };
    var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** Locate a full 6-digit PIN, falling back 3 -> 2 digits. Null if unknown. */
  function locate(pincode) {
    var pin = String(pincode || '').replace(/\D/g, '');
    if (pin.length < 3) return null;
    var idx = index();
    if (idx[pin.substring(0, 3)]) return idx[pin.substring(0, 3)];

    // Fall back to the nearest known prefix sharing the first two digits -
    // same postal circle, so the centroid is still in the right region.
    var two = pin.substring(0, 2);
    var candidates = Object.keys(idx).filter(function (k) { return k.substring(0, 2) === two; });
    if (!candidates.length) return null;
    candidates.sort();
    return idx[candidates[0]];
  }

  /**
   * Distance in km from a student's home PIN to the NEAREST campus.
   * Dwarka and EDC are one allocation pool, so the relevant distance is to
   * whichever campus is closer.
   * @return {{km: number, campus: string, district: string, state: string, resolved: boolean}}
   */
  function distanceFromHome(pincode) {
    var loc = locate(pincode);
    if (!loc) {
      return { km: -1, campus: null, district: '', state: '', resolved: false };
    }
    var best = null;
    Object.keys(CAMPUSES).forEach(function (key) {
      var c = CAMPUSES[key];
      var km = haversine(Number(loc.lat), Number(loc.lng), c.lat, c.lng);
      if (!best || km < best.km) best = { km: km, campus: key };
    });
    return {
      km: Util.round(best.km, 1),
      campus: best.campus,
      district: loc.district,
      state: loc.state,
      resolved: true
    };
  }

  return {
    haversine: haversine,
    locate: locate,
    distanceFromHome: distanceFromHome,
    index: index,
    invalidate: invalidate
  };
})();
