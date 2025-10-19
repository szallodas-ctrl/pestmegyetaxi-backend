// PestMegyeTaxi Backend API
// Node.js + Express + Supabase + Socket.io

const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Store active connections
const activeDrivers = new Map(); // driverId -> socketId
const activePassengers = new Map(); // passengerId -> socketId

// ==================== AUTHENTICATION ====================

// Register/Login (handled by Supabase, but we track user type)
app.post('/api/auth/register', async (req, res) => {
  const { email, password, userType, name, phone } = req.body;
  
  try {
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password
    });

    if (authError) throw authError;

    // Create profile based on user type
    if (userType === 'driver') {
      const { error: profileError } = await supabase
        .from('drivers')
        .insert([{
          user_id: authData.user.id,
          name,
          phone,
          is_available: false,
          rating: 5.0,
          total_rides: 0
        }]);
      
      if (profileError) throw profileError;
    } else {
      const { error: profileError } = await supabase
        .from('passengers')
        .insert([{
          user_id: authData.user.id,
          name,
          phone,
          rating: 5.0
        }]);
      
      if (profileError) throw profileError;
    }

    res.json({ success: true, user: authData.user });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get user profile
app.get('/api/auth/profile/:userId', async (req, res) => {
  const { userId } = req.params;
  
  try {
    // Check if driver
    const { data: driver } = await supabase
      .from('drivers')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (driver) {
      return res.json({ userType: 'driver', profile: driver });
    }

    // Check if passenger
    const { data: passenger } = await supabase
      .from('passengers')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (passenger) {
      return res.json({ userType: 'passenger', profile: passenger });
    }

    res.status(404).json({ error: 'Profile not found' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== DRIVER ENDPOINTS ====================

// Simple driver registration (no auth required)
app.post('/api/drivers/register', async (req, res) => {
  const { name, phone, license_plate, car_model, car_color } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('drivers')
      .insert([{
        name,
        phone,
        license_plate,
        car_model,
        car_color,
        status: 'pending',
        is_available: false,
        rating: 5.0,
        total_rides: 0
      }])
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, driver: data });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Update driver availability
app.post('/api/driver/availability', async (req, res) => {
  const { driverId, isAvailable } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('drivers')
      .update({ is_available: isAvailable })
      .eq('id', driverId)
      .select()
      .single();
    
    if (error) throw error;
    
    res.json({ success: true, driver: data });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Update driver location
app.post('/api/driver/location', async (req, res) => {
  const { driverId, latitude, longitude } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('drivers')
      .update({ 
        current_latitude: latitude,
        current_longitude: longitude,
        last_location_update: new Date().toISOString()
      })
      .eq('id', driverId)
      .select()
      .single();
    
    if (error) throw error;
    
    // Notify passenger if driver is on active ride
    const { data: activeRide } = await supabase
      .from('rides')
      .select('passenger_id')
      .eq('driver_id', driverId)
      .eq('status', 'accepted')
      .single();
    
    if (activeRide && activePassengers.has(activeRide.passenger_id)) {
      const passengerSocket = activePassengers.get(activeRide.passenger_id);
      io.to(passengerSocket).emit('driver_location_update', {
        latitude,
        longitude
      });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get driver stats
app.get('/api/driver/stats/:driverId', async (req, res) => {
  const { driverId } = req.params;
  
  try {
    const { data: driver } = await supabase
      .from('drivers')
      .select('total_rides, rating')
      .eq('id', driverId)
      .single();
    
    const { data: todayRides, count } = await supabase
      .from('rides')
      .select('*', { count: 'exact' })
      .eq('driver_id', driverId)
      .gte('created_at', new Date().toISOString().split('T')[0])
      .eq('status', 'completed');
    
    res.json({
      totalRides: driver.total_rides,
      rating: driver.rating,
      todayRides: count || 0
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Accept ride
app.post('/api/driver/accept-ride', async (req, res) => {
  const { rideId, driverId } = req.body;
  
  try {
    // Update ride status
    const { data: ride, error } = await supabase
      .from('rides')
      .update({ 
        driver_id: driverId,
        status: 'accepted',
        accepted_at: new Date().toISOString()
      })
      .eq('id', rideId)
      .eq('status', 'pending')
      .select()
      .single();
    
    if (error) throw error;
    
    // Get driver details
    const { data: driver } = await supabase
      .from('drivers')
      .select('*')
      .eq('id', driverId)
      .single();
    
    // Notify passenger
    if (activePassengers.has(ride.passenger_id)) {
      const passengerSocket = activePassengers.get(ride.passenger_id);
      io.to(passengerSocket).emit('ride_accepted', {
        ride,
        driver
      });
    }
    
    res.json({ success: true, ride });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Complete ride
app.post('/api/driver/complete-ride', async (req, res) => {
  const { rideId, driverId, finalFare } = req.body;
  
  try {
    const { data: ride, error } = await supabase
      .from('rides')
      .update({ 
        status: 'completed',
        completed_at: new Date().toISOString(),
        final_fare: finalFare
      })
      .eq('id', rideId)
      .eq('driver_id', driverId)
      .select()
      .single();
    
    if (error) throw error;
    
    // Update driver stats
    await supabase.rpc('increment_driver_rides', { driver_id: driverId });
    
    // Notify passenger
    if (activePassengers.has(ride.passenger_id)) {
      const passengerSocket = activePassengers.get(ride.passenger_id);
      io.to(passengerSocket).emit('ride_completed', { ride });
    }
    
    res.json({ success: true, ride });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== PASSENGER ENDPOINTS ====================

// Request ride
app.post('/api/passenger/request-ride', async (req, res) => {
  const { 
    passengerId, 
    pickupAddress, 
    pickupLat, 
    pickupLng,
    destinationAddress,
    destinationLat,
    destinationLng,
    estimatedDistance,
    estimatedFare
  } = req.body;
  
  try {
    // Create ride
    const { data: ride, error } = await supabase
      .from('rides')
      .insert([{
        passenger_id: passengerId,
        pickup_address: pickupAddress,
        pickup_latitude: pickupLat,
        pickup_longitude: pickupLng,
        destination_address: destinationAddress,
        destination_latitude: destinationLat,
        destination_longitude: destinationLng,
        estimated_distance: estimatedDistance,
        estimated_fare: estimatedFare,
        status: 'pending'
      }])
      .select()
      .single();
    
    if (error) throw error;
    
    // Find nearby available drivers (within 10km)
    const { data: nearbyDrivers } = await supabase.rpc('find_nearby_drivers', {
      lat: pickupLat,
      lng: pickupLng,
      radius_km: 10
    });
    
    // Notify nearby drivers via WebSocket
    nearbyDrivers?.forEach(driver => {
      if (activeDrivers.has(driver.id)) {
        const driverSocket = activeDrivers.get(driver.id);
        io.to(driverSocket).emit('new_ride_request', {
          ride,
          distance: driver.distance
        });
      }
    });
    
    res.json({ success: true, ride, nearbyDriversCount: nearbyDrivers?.length || 0 });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Cancel ride
app.post('/api/passenger/cancel-ride', async (req, res) => {
  const { rideId, passengerId } = req.body;
  
  try {
    const { data: ride, error } = await supabase
      .from('rides')
      .update({ 
        status: 'cancelled',
        cancelled_at: new Date().toISOString()
      })
      .eq('id', rideId)
      .eq('passenger_id', passengerId)
      .in('status', ['pending', 'accepted'])
      .select()
      .single();
    
    if (error) throw error;
    
    // Notify driver if ride was accepted
    if (ride.driver_id && activeDrivers.has(ride.driver_id)) {
      const driverSocket = activeDrivers.get(ride.driver_id);
      io.to(driverSocket).emit('ride_cancelled', { rideId });
    }
    
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Get ride status
app.get('/api/passenger/ride-status/:rideId', async (req, res) => {
  const { rideId } = req.params;
  
  try {
    const { data: ride } = await supabase
      .from('rides')
      .select(`
        *,
        driver:drivers(*)
      `)
      .eq('id', rideId)
      .single();
    
    res.json({ ride });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== RATINGS ====================

// Rate driver
app.post('/api/rating/rate-driver', async (req, res) => {
  const { rideId, rating, comment } = req.body;
  
  try {
    // Get ride details
    const { data: ride } = await supabase
      .from('rides')
      .select('driver_id')
      .eq('id', rideId)
      .single();
    
    // Create rating
    await supabase
      .from('ratings')
      .insert([{
        ride_id: rideId,
        driver_id: ride.driver_id,
        rating,
        comment,
        rated_by: 'passenger'
      }]);
    
    // Update driver's average rating
    await supabase.rpc('update_driver_rating', { driver_id: ride.driver_id });
    
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Rate passenger
app.post('/api/rating/rate-passenger', async (req, res) => {
  const { rideId, rating, comment } = req.body;
  
  try {
    const { data: ride } = await supabase
      .from('rides')
      .select('passenger_id')
      .eq('id', rideId)
      .single();
    
    await supabase
      .from('ratings')
      .insert([{
        ride_id: rideId,
        passenger_id: ride.passenger_id,
        rating,
        comment,
        rated_by: 'driver'
      }]);
    
    await supabase.rpc('update_passenger_rating', { passenger_id: ride.passenger_id });
    
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ==================== WEBSOCKET (Real-time) ====================

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  // Driver comes online
  socket.on('driver_online', (data) => {
    activeDrivers.set(data.driverId, socket.id);
    console.log(`Driver ${data.driverId} is online`);
  });
  
  // Passenger comes online
  socket.on('passenger_online', (data) => {
    activePassengers.set(data.passengerId, socket.id);
    console.log(`Passenger ${data.passengerId} is online`);
  });
  
  // Driver location update (real-time)
  socket.on('update_location', async (data) => {
    const { driverId, latitude, longitude } = data;
    
    // Update in database
    await supabase
      .from('drivers')
      .update({ 
        current_latitude: latitude,
        current_longitude: longitude 
      })
      .eq('id', driverId);
    
    // Notify passenger if on active ride
    const { data: activeRide } = await supabase
      .from('rides')
      .select('passenger_id')
      .eq('driver_id', driverId)
      .eq('status', 'accepted')
      .single();
    
    if (activeRide && activePassengers.has(activeRide.passenger_id)) {
      const passengerSocket = activePassengers.get(activeRide.passenger_id);
      io.to(passengerSocket).emit('driver_location_update', {
        latitude,
        longitude
      });
    }
  });
  
  socket.on('disconnect', () => {
    // Remove from active connections
    for (const [driverId, socketId] of activeDrivers.entries()) {
      if (socketId === socket.id) {
        activeDrivers.delete(driverId);
        console.log(`Driver ${driverId} disconnected`);
      }
    }
    
    for (const [passengerId, socketId] of activePassengers.entries()) {
      if (socketId === socket.id) {
        activePassengers.delete(passengerId);
        console.log(`Passenger ${passengerId} disconnected`);
      }
    }
  });
});

// ==================== UTILITY ENDPOINTS ====================

// Calculate fare
app.post('/api/utility/calculate-fare', (req, res) => {
  const { distance } = req.body; // distance in km
  
  const BASE_FARE = 800; // 800 Ft
  const PER_KM = 350; // 350 Ft per km
  
  const estimatedFare = BASE_FARE + (PER_KM * distance);
  
  res.json({ 
    estimatedFare: Math.round(estimatedFare),
    breakdown: {
      baseFare: BASE_FARE,
      distanceCost: Math.round(PER_KM * distance),
      distance
    }
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    activeDrivers: activeDrivers.size,
    activePassengers: activePassengers.size
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚕 PestMegyeTaxi API running on port ${PORT}`);
  console.log(`📡 WebSocket server ready`);
});

module.exports = app;
